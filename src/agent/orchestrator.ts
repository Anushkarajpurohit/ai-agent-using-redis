// orchestrator.tsx
import { classifyIntent } from "./intent-classifier";
import { resolveSpecialization } from "./specialization-map";
import {
  resolveDoctorSelection,
  resolveDateSelection,
  resolveTimeSelection,
  extractValidName,
  extractValidPhone,
  extractDoctorNameQuery
} from "./selectors";
import { loadSession, saveSession } from "./session-store";
import { phraseResponse } from "./llm";
import { getDoctorsBySpecialization } from "../db/queries/doctors";
import { getDoctorWeekAvailability } from "../db/queries/slots";
import {
  bookSlot,
  cancelAppointment,
  getUpcomingAppointmentsByPhone,
} from "../db/queries/appointments";
import { ConversationSession, TurnFacts, Intent } from "./types";
export interface OrchestratorResult {
  reply: string;
  stage: ConversationSession["stage"];
  options?: Record<string, unknown>;
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatTimeLabel(hhmmss: string): string {
  const [h, m] = hhmmss.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}
function forceGlobalIntent(
  text: string,
  stage: ConversationSession["stage"],
  classified: Intent
): Intent {
  const t = text.toLowerCase();

  const mentionsAppointment = /\bappointments?\b/.test(t);
  const wantsLookup = mentionsAppointment && /\b(check|view|see|show|list|look\s*up|find|get|upcoming|future)\b/.test(t);
  const wantsCancel = mentionsAppointment && /\b(cancel|delete|remove)\b/.test(t);
  const wantsReschedule = /\breschedul(e|ing)\b/i.test(t);

  // CRITICAL FIX: Do not restart reschedule flow if we are already inside it.
  // Stages that belong to an in-progress reschedule/cancel/booking flow should
  // be preserved — otherwise the user gets stuck in a loop being asked for
  // their phone number again and again.
  const inActiveFlow =
    stage === "awaiting_patient_phone" ||
    stage === "awaiting_date_selection" ||
    stage === "awaiting_time_selection" ||
    stage === "awaiting_patient_name" ||
    stage === "awaiting_confirmation" ||
    stage === "cancelling_select_appointment" ||
    stage === "cancelling_confirm";

  if (wantsReschedule && !inActiveFlow) return "reschedule_appointment";
  if (wantsCancel && !inActiveFlow) return "cancel_appointment";
  if (wantsLookup && !inActiveFlow) return "check_appointments";

  if (stage !== "cancelling_confirm" && wantsCancel && !inActiveFlow) {
    if (/\b(don'?t|do not|never|abort|stop)\b/i.test(t) && /\bcancel\b/i.test(t)) {
      return "confirm_no";
    }
    if (/\b(yes|yeah|sure|ok|okay|confirm)\b/i.test(t)) return "confirm_yes";
    if (/\b(no|nope)\b/i.test(t)) return "confirm_no";
  }

  return classified;
}

function clearBookingDraft(session: ConversationSession) {
  delete session.symptomText;
  delete session.specialization;
  delete session.candidateDoctors;
  delete session.selectedDoctorId;
  delete session.selectedDoctorName;
  delete session.availableDates;
  delete session.selectedDate;
  delete session.availableSlotsForDate;
  delete session.selectedSlotId;
  delete session.selectedSlotTime;
  delete session.patientName;
  delete session.reasonForVisit;
}
export async function handleTurn(
  sessionId: string,
  userText: string
): Promise<OrchestratorResult> {
  const session = await loadSession(sessionId);

  const rawIntent = classifyIntent(userText, session.stage);
  const intent = forceGlobalIntent(userText, session.stage, rawIntent);

  console.log(
    `[ORCHESTRATOR] session=${sessionId} stage=${session.stage} rawIntent=${rawIntent} intent=${intent} text="${userText}"`
  );

  let facts: TurnFacts;
  const inActiveFlow =
    session.stage === "awaiting_patient_phone" ||
    session.stage === "awaiting_date_selection" ||
    session.stage === "awaiting_time_selection" ||
    session.stage === "awaiting_patient_name" ||
    session.stage === "awaiting_confirmation" ||
    session.stage === "cancelling_select_appointment" ||
    session.stage === "cancelling_confirm";
  const inCancellationFlow =
    session.stage === "cancelling_select_appointment" ||
    session.stage === "cancelling_confirm";

  if (intent === "goodbye") {
    session.stage = "done";

    facts = {
      intent,
      stage: session.stage,
      nextStage: "done",
      action: "goodbye",
      data: {},
    };
  } else if (intent === "check_appointments") {
    clearBookingDraft(session);

    session.stage = "awaiting_patient_phone";
    session.phonePurpose = "lookup";

    delete (session as any)._phoneReasonIsLookup;
    delete (session as any)._phoneReasonIsCancel;

    facts = {
      intent,
      stage: "checking_appointments",
      nextStage: "awaiting_patient_phone",
      action: "ask_phone",
      data: { purpose: "lookup" },
    };
  } else if (intent === "reschedule_appointment" && !inActiveFlow) {
    clearBookingDraft(session);
    session.stage = "awaiting_patient_phone";
    session.phonePurpose = "reschedule";

    facts = {
      intent,
      stage: "rescheduling_lookup",
      nextStage: "awaiting_patient_phone",
      action: "ask_phone",
      data: { purpose: "reschedule" },
    };

    // } else if (intent === "reschedule_appointment" && !inCancellationFlow) {

    //   clearBookingDraft(session);
    //   session.stage = "awaiting_patient_phone";
    //   session.phonePurpose = "reschedule";  // NEW distinct purpose

    //   facts = {
    //     intent,
    //     stage: "rescheduling_lookup",
    //     nextStage: "awaiting_patient_phone",
    //     action: "ask_phone",
    //     data: { purpose: "reschedule" },
    //   };
  } else if (intent === "cancel_appointment" && !inActiveFlow) {
    clearBookingDraft(session);

    session.stage = "awaiting_patient_phone";
    session.phonePurpose = "cancel";

    delete (session as any)._phoneReasonIsLookup;
    delete (session as any)._phoneReasonIsCancel;

    facts = {
      intent,
      stage: "cancelling_select_appointment",
      nextStage: "awaiting_patient_phone",
      action: "ask_phone",
      data: { purpose: "cancel" },
    };
  } else if (intent === "greeting" && !resolveSpecialization(userText).confident) {
    session.stage = "awaiting_symptom_or_request";

    facts = {
      intent,
      stage: "greeting",
      nextStage: "awaiting_symptom_or_request",
      action: "ask_symptom",
      data: {},
    };
  } else {
    facts = await routeByStage(session, intent, userText);
  }

  await saveSession(session);

  const reply = await phraseResponse(facts);

  return {
    reply,
    stage: session.stage,
    options: facts.data,
  };
}
// Utility to clear session state when switching context
function cleanupBookingState(session: ConversationSession) {
  delete session.selectedDoctorId;
  delete session.selectedDoctorName;
  delete session.selectedDate;
  delete session.selectedSlotId;
  delete session.selectedSlotTime;
  delete session.patientName;
  delete session.patientPhone;
  delete session.availableDates;
  delete session.availableSlotsForDate;
}

async function routeByStage(
  session: ConversationSession,
  intent: string,
  userText: string
): Promise<TurnFacts> {
  switch (session.stage) {
    case "greeting":
    case "awaiting_symptom_or_request": {
      // Allow searching directly by a doctor's name if they said "I want to book Dr. Kapoor"
      const { specialization, matchedKeyword, confident } = resolveSpecialization(userText);

      session.symptomText = userText;
      session.specialization = specialization;

      const doctors = await getDoctorsBySpecialization(specialization);
      session.candidateDoctors = doctors;

      // Escape hatch: check if they typed/spoke a doctor's name directly
      const directDocMatch = resolveDoctorSelection(userText, doctors);
      if (directDocMatch) {
        session.selectedDoctorId = directDocMatch.id;
        session.selectedDoctorName = directDocMatch.name;

        const week = await getDoctorWeekAvailability(directDocMatch.id);
        const availableDates = Object.keys(week.slotsByDate).filter(
          (d) => week.slotsByDate[d].length > 0
        );
        session.availableDates = availableDates;
        session.stage = "awaiting_date_selection";

        return {
          intent: "doctor_selection" as any,
          stage: "awaiting_symptom_or_request",
          nextStage: "awaiting_date_selection",
          action: "list_dates",
          data: {
            doctorName: directDocMatch.name,
            dates: availableDates.map(formatDateLabel),
            rawDates: availableDates,
          },
        };
      }

      if (doctors.length === 0) {
        session.stage = "awaiting_symptom_or_request";
        return {
          intent: intent as any,
          stage: "awaiting_symptom_or_request",
          nextStage: "awaiting_symptom_or_request",
          action: "clarify_unknown",
          data: { reason: "no_doctors_for_specialization", specialization, confident },
        };
      }

      session.stage = "awaiting_doctor_selection";
      return {
        intent: intent as any,
        stage: "awaiting_symptom_or_request",
        nextStage: "awaiting_doctor_selection",
        action: "list_doctors",
        data: {
          specialization,
          matchedKeyword,
          doctors: doctors.map((d) => ({
            id: d.id,
            name: d.name,
            qualifications: d.qualifications,
            yearsExperience: d.yearsExperience,
            clinicName: d.clinicName,
          })),
        },
      };
    }

    case "awaiting_doctor_selection": {
      const chosen = resolveDoctorSelection(userText, session.candidateDoctors ?? []);
      if (!chosen) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_doctor_choice",
          data: { doctors: session.candidateDoctors ?? [] },
        };
      }

      session.selectedDoctorId = chosen.id;
      session.selectedDoctorName = chosen.name;

      const week = await getDoctorWeekAvailability(chosen.id);
      const availableDates = Object.keys(week.slotsByDate).filter(
        (d) => week.slotsByDate[d].length > 0
      );
      session.availableDates = availableDates;

      if (availableDates.length === 0) {
        session.stage = "awaiting_doctor_selection";
        return {
          intent: intent as any,
          stage: "awaiting_doctor_selection",
          nextStage: "awaiting_doctor_selection",
          action: "clarify_unknown",
          data: { reason: "no_availability", doctorName: chosen.name },
        };
      }

      session.stage = "awaiting_date_selection";
      return {
        intent: intent as any,
        stage: "awaiting_doctor_selection",
        nextStage: "awaiting_date_selection",
        action: "list_dates",
        data: {
          doctorName: chosen.name,
          dates: availableDates.map(formatDateLabel),
          rawDates: availableDates,
        },
      };
    }

    case "awaiting_date_selection": {
      const result = resolveDateSelection(userText, session.availableDates ?? []);

      if (!result.matchedIso) {
        if (result.requestedIso) {
          return {
            intent: intent as any,
            stage: session.stage,
            nextStage: session.stage,
            action: "date_unavailable",
            data: {
              requestedDate: formatDateLabel(result.requestedIso),
              dates: (session.availableDates ?? []).map(formatDateLabel),
            },
          };
        }
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_date_choice",
          data: { dates: (session.availableDates ?? []).map(formatDateLabel) },
        };
      }

      const chosenDate = result.matchedIso;
      session.selectedDate = chosenDate;

      const week = await getDoctorWeekAvailability(session.selectedDoctorId!);
      const slots = week.slotsByDate[chosenDate] ?? [];
      session.availableSlotsForDate = slots;

      session.stage = "awaiting_time_selection";
      return {
        intent: intent as any,
        stage: "awaiting_date_selection",
        nextStage: "awaiting_time_selection",
        action: "list_slots",
        data: {
          date: formatDateLabel(chosenDate),
          times: slots.map((s) => formatTimeLabel(s.startTime)),
        },
      };
    }

    case "awaiting_time_selection": {
      const result = resolveTimeSelection(userText, session.availableSlotsForDate ?? []);

      if (!result.matchedSlot) {
        if (result.requestedLabel) {
          return {
            intent: intent as any,
            stage: session.stage,
            nextStage: session.stage,
            action: "time_unavailable",
            data: {
              requestedTime: result.requestedLabel,
              times: (session.availableSlotsForDate ?? []).map((s) => formatTimeLabel(s.startTime)),
            },
          };
        }
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_time_choice",
          data: { times: (session.availableSlotsForDate ?? []).map((s) => formatTimeLabel(s.startTime)) },
        };
      }

      const chosenSlot = result.matchedSlot;
      session.selectedSlotId = chosenSlot.id;
      session.selectedSlotTime = formatTimeLabel(chosenSlot.startTime);

      session.stage = "awaiting_patient_name";
      return {
        intent: intent as any,
        stage: "awaiting_time_selection",
        nextStage: "awaiting_patient_name",
        action: "ask_name",
        data: {},
      };
    }

    case "awaiting_patient_name": {
      const validName = extractValidName(userText);
      if (!validName) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_name",
          data: { retry: true },
        };
      }
      session.patientName = validName;
      session.stage = "awaiting_patient_phone";
      session.phonePurpose = "booking";
      return {
        intent: intent as any,
        stage: "awaiting_patient_name",
        nextStage: "awaiting_patient_phone",
        action: "ask_phone",
        data: {},
      };
    }

    case "awaiting_patient_phone": {
      const phone = extractValidPhone(userText);

      if (!phone) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_phone",
          data: { retry: true, purpose: session.phonePurpose },
        };
      }

      session.patientPhone = phone;
      const purpose = session.phonePurpose ?? "booking";

      // --- LOOKUP FLOW ---
      if (purpose === "lookup") {
        const appts = await getUpcomingAppointmentsByPhone(phone);

        session.lastAppointments = appts.map((a) => ({
          appointmentId: a.appointmentId,
          doctorName: a.doctorName,
          date: formatDateLabel(a.slotDate as unknown as string),
          time: formatTimeLabel(a.startTime as unknown as string),
          status: a.status,
          doctorId: a.doctorId!,
        }));

        if (session.lastAppointments.length === 0) {
          return {
            intent: "check_appointments",
            stage: "awaiting_patient_phone",
            nextStage: "awaiting_patient_phone",
            action: "no_appointments_retry",
            data: { phone, canRetry: true },
          };
        }

        session.phonePurpose = undefined;
        session.stage = "done";
        return {
          intent: "check_appointments",
          stage: "awaiting_patient_phone",
          nextStage: "done",
          action: "list_appointments",
          data: { appointments: session.lastAppointments },
        };
      }

      // --- RESCHEDULE FLOW ---
      if (purpose === "reschedule") {
        const appts = await getUpcomingAppointmentsByPhone(phone);

        console.log(`[RESCHEDULE] found ${appts.length} appointments for phone ${phone}`);

        session.lastAppointments = appts.map((a) => ({
          appointmentId: a.appointmentId,
          doctorName: a.doctorName,
          date: formatDateLabel(a.slotDate as unknown as string),
          time: formatTimeLabel(a.startTime as unknown as string),
          status: a.status,
          doctorId: a.doctorId!,
        }));

        if (session.lastAppointments.length === 0) {
          // Stay on awaiting_patient_phone so they can retry — but clear purpose
          // so a follow-up "reschedule" utterance can restart cleanly.
          return {
            intent: "reschedule_appointment",
            stage: "awaiting_patient_phone",
            nextStage: "awaiting_patient_phone",
            action: "no_appointments_retry",
            data: { phone, canRetry: true, context: "reschedule" },
          };
        }

        if (session.lastAppointments.length === 1) {
          const only = session.lastAppointments[0];
          session.appointmentToCancelId = only.appointmentId;
          session.rescheduleContext = {
            doctorId: only.doctorId!,
            doctorName: only.doctorName,
            patientPhone: phone,
          };
          session.phonePurpose = undefined;  // ← IMPORTANT: clear so we don't re-ask phone
          session.stage = "cancelling_confirm";

          console.log(`[RESCHEDULE] single appt found, moving to cancelling_confirm`);

          return {
            intent: "reschedule_appointment",
            stage: "awaiting_patient_phone",
            nextStage: "cancelling_confirm",
            action: "confirm_reschedule",
            data: {
              doctorName: only.doctorName,
              date: only.date,
              time: only.time,
            },
          };
        }
        session.phonePurpose = undefined;  // ← clear
        session.stage = "cancelling_select_appointment";
        return {
          intent: "reschedule_appointment",
          stage: "awaiting_patient_phone",
          nextStage: "cancelling_select_appointment",
          action: "ask_which_to_reschedule",
          data: { appointments: session.lastAppointments },
        };
      }


      // --- CANCEL FLOW ---
      if (purpose === "cancel") {
        const appts = await getUpcomingAppointmentsByPhone(phone);

        session.lastAppointments = appts.map((a) => ({
          appointmentId: a.appointmentId,
          doctorName: a.doctorName,
          date: formatDateLabel(a.slotDate as unknown as string),
          time: formatTimeLabel(a.startTime as unknown as string),
          status: a.status,
          doctorId: a.doctorId!,
        }));

        if (session.lastAppointments.length === 0) {
          return {
            intent: "cancel_appointment",
            stage: "awaiting_patient_phone",
            nextStage: "awaiting_patient_phone",
            action: "no_appointments_retry",
            data: { phone, canRetry: true },
          };
        }

        if (session.lastAppointments.length === 1) {
          const only = session.lastAppointments[0];
          session.appointmentToCancelId = only.appointmentId;
          session.stage = "cancelling_confirm";

          return {
            intent: "cancel_appointment",
            stage: "awaiting_patient_phone",
            nextStage: "cancelling_confirm",
            action: "confirm_cancellation",
            data: {
              doctorName: only.doctorName,
              date: only.date,
              time: only.time,
            },
          };
        }

        session.stage = "cancelling_select_appointment";
        return {
          intent: "cancel_appointment",
          stage: "awaiting_patient_phone",
          nextStage: "cancelling_select_appointment",
          action: "ask_which_to_cancel",
          data: { appointments: session.lastAppointments },
        };
      }

      // --- BOOKING FLOW ---
      session.phonePurpose = undefined;
      session.stage = "awaiting_confirmation";

      return {
        intent: "provide_phone",
        stage: "awaiting_patient_phone",
        nextStage: "awaiting_confirmation",
        action: "confirm_booking_details",
        data: {
          doctorName: session.selectedDoctorName,
          date: session.selectedDate ? formatDateLabel(session.selectedDate) : undefined,
          time: session.selectedSlotTime,
          patientName: session.patientName,
        },
      };
    }

    case "awaiting_confirmation": {
      if (intent === "confirm_no") {
        const dateResult = resolveDateSelection(userText, session.availableDates ?? []);
        if (dateResult.matchedIso) {
          session.selectedDate = dateResult.matchedIso;
          const week = await getDoctorWeekAvailability(session.selectedDoctorId!);
          session.availableSlotsForDate = week.slotsByDate[dateResult.matchedIso] ?? [];
          session.stage = "awaiting_time_selection";
          return {
            intent: intent as any,
            stage: "awaiting_confirmation",
            nextStage: "awaiting_time_selection",
            action: "list_slots",
            data: {
              date: formatDateLabel(dateResult.matchedIso),
              times: session.availableSlotsForDate.map((s) => formatTimeLabel(s.startTime)),
            },
          };
        }

        const timeResult = resolveTimeSelection(userText, session.availableSlotsForDate ?? []);
        if (timeResult.matchedSlot) {
          session.selectedSlotId = timeResult.matchedSlot.id;
          session.selectedSlotTime = formatTimeLabel(timeResult.matchedSlot.startTime);
          return {
            intent: intent as any,
            stage: "awaiting_confirmation",
            nextStage: "awaiting_confirmation",
            action: "confirm_booking_details",
            data: {
              doctorName: session.selectedDoctorName,
              date: formatDateLabel(session.selectedDate!),
              time: session.selectedSlotTime,
              patientName: session.patientName,
            },
          };
        }

        session.stage = "awaiting_change_target";
        return {
          intent: intent as any,
          stage: "awaiting_confirmation",
          nextStage: "awaiting_change_target",
          action: "ask_change_target",
          data: {},
        };
      }

      const result = await bookSlot({
        slotId: session.selectedSlotId!,
        doctorId: session.selectedDoctorId!,
        patientName: session.patientName!,
        patientPhone: session.patientPhone!,
        reasonForVisit: session.symptomText,
      });

      if (!result.ok) {
        session.stage = "awaiting_time_selection";
        const week = await getDoctorWeekAvailability(session.selectedDoctorId!);
        session.availableSlotsForDate = week.slotsByDate[session.selectedDate!] ?? [];
        return {
          intent: intent as any,
          stage: "awaiting_confirmation",
          nextStage: "awaiting_time_selection",
          action: "booking_failed",
          data: { times: session.availableSlotsForDate.map((s) => formatTimeLabel(s.startTime)) },
        };
      }

      session.stage = "booked";
      return {
        intent: intent as any,
        stage: "awaiting_confirmation",
        nextStage: "booked",
        action: "booking_success",
        data: {
          appointmentId: result.appointmentId,
          doctorName: session.selectedDoctorName,
          date: formatDateLabel(session.selectedDate!),
          time: session.selectedSlotTime,
        },
      };
    }

    case "awaiting_change_target": {
      const lower = userText.toLowerCase();

      if (/\bdate\b/.test(lower)) {
        session.stage = "awaiting_date_selection";
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: "awaiting_date_selection",
          action: "list_dates",
          data: {
            doctorName: session.selectedDoctorName,
            dates: (session.availableDates ?? []).map(formatDateLabel),
          },
        };
      }
      if (/\btime\b/.test(lower)) {
        session.stage = "awaiting_time_selection";
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: "awaiting_time_selection",
          action: "list_slots",
          data: {
            date: session.selectedDate ? formatDateLabel(session.selectedDate) : undefined,
            times: (session.availableSlotsForDate ?? []).map((s) => formatTimeLabel(s.startTime)),
          },
        };
      }
      if (/\bdoctor\b/.test(lower)) {
        session.stage = "awaiting_doctor_selection";
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: "awaiting_doctor_selection",
          action: "list_doctors",
          data: { doctors: session.candidateDoctors ?? [] },
        };
      }

      return {
        intent: intent as any,
        stage: session.stage,
        nextStage: session.stage,
        action: "ask_change_target",
        data: {},
      };
    }

    case "cancelling_select_appointment": {
      // Reuse existing selection logic but set rescheduleContext instead of just cancelId
      const idxMatch = userText.match(/\b(\d)\b/);
      const ordinalMap: Record<string, number> = { first: 0, second: 1, third: 2 };
      let idx: number | null = idxMatch ? parseInt(idxMatch[1], 10) - 1 : null;
      if (idx === null) {
        for (const [w, i] of Object.entries(ordinalMap)) {
          if (userText.toLowerCase().includes(w)) idx = i;
        }
      }
      let chosen = idx !== null ? session.lastAppointments?.[idx] : null;

      if (!chosen) {
        const lower = userText.toLowerCase();
        chosen = session.lastAppointments?.find((a) =>
          lower.includes(a.doctorName.toLowerCase().replace(/^dr\.?\s*/i, ""))
        ) ?? null;
      }

      if (!chosen) {
        const isReschedule = session.rescheduleContext !== undefined ||
          intent === "reschedule_appointment";

        return {

          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: isReschedule ? "ask_which_to_reschedule" : "ask_which_to_cancel",
          data: { appointments: session.lastAppointments ?? [] },
        };
      }

      session.appointmentToCancelId = chosen.appointmentId;

      // If we're in reschedule flow, store context
      if (intent === "reschedule_appointment" || session.rescheduleContext) {
        session.rescheduleContext = {
          doctorId: chosen.doctorId!,
          doctorName: chosen.doctorName,
          patientPhone: session.patientPhone!,
        };
        session.stage = "cancelling_confirm";
        return {
          intent: "reschedule_appointment",
          stage: "cancelling_select_appointment",
          nextStage: "cancelling_confirm",
          action: "confirm_reschedule",
          data: { doctorName: chosen.doctorName, date: chosen.date, time: chosen.time },
        };
      }


      // Otherwise normal cancel
      session.stage = "cancelling_confirm";
      return {
        intent: intent as any,
        stage: "cancelling_select_appointment",
        nextStage: "cancelling_confirm",
        action: "confirm_cancellation",
        data: { doctorName: chosen.doctorName, date: chosen.date, time: chosen.time },
      };
    }
    case "cancelling_confirm": {
      // FIX #2: Properly handle "no" / "don't cancel"
      if (intent === "confirm_no" || intent === "unknown") {  // Treat unknown as no in this sensitive stage
        session.stage = "done";
        return {
          intent: intent as any,
          stage: "cancelling_confirm",
          nextStage: "done",
          action: "goodbye",
          data: {},
        };
      }

      // If we get here, user confirmed yes (or we fell through)
      const apptId = session.appointmentToCancelId!;
      await cancelAppointment(apptId);

      // FIX #1: If this was a reschedule request, immediately start rebooking
      if (session.rescheduleContext) {
        const ctx = session.rescheduleContext;
        // Pre-populate session for booking
        session.selectedDoctorId = ctx.doctorId;
        session.selectedDoctorName = ctx.doctorName;
        session.patientPhone = ctx.patientPhone;
        session.patientName = session.patientName || "the patient";  // Use previous if available

        // Fetch availability for this doctor
        const week = await getDoctorWeekAvailability(ctx.doctorId);
        const availableDates = Object.keys(week.slotsByDate).filter(
          (d) => week.slotsByDate[d].length > 0
        );
        session.availableDates = availableDates;
        session.rescheduleContext = undefined;  // Clear context
        session.appointmentToCancelId = undefined;

        session.stage = "awaiting_date_selection";
        return {
          intent: "reschedule_appointment",
          stage: "cancelling_confirm",
          nextStage: "awaiting_date_selection",
          action: "reschedule_select_date",  // LLM says "Cancelled. When would you like the new appointment?"
          data: {
            doctorName: ctx.doctorName,
            dates: availableDates.map(formatDateLabel),
            rawDates: availableDates,
          },
        };
      }

      // Normal cancellation
      session.stage = "awaiting_symptom_or_request";
      return {
        intent: intent as any,
        stage: "cancelling_confirm",
        nextStage: "awaiting_symptom_or_request",
        action: "cancellation_success",
        data: { offerRebook: true },
      };
    }

    default: {
      session.stage = "awaiting_symptom_or_request";
      return routeByStage(session, intent, userText);
    }
  }
}