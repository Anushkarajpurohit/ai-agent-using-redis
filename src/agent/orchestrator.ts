import { classifyIntent } from "./intent-classifier";
import { resolveSpecialization } from "./specialization-map";
import {
  resolveDoctorSelection,
  resolveDateSelection,
  resolveTimeSelection,
  extractValidName,
  extractValidPhone,
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
import { ConversationSession, TurnFacts } from "./types";

export interface OrchestratorResult {
  reply: string;
  stage: ConversationSession["stage"];
  // UI-friendly structured options so the frontend can also render buttons,
  // not just rely on voice — same deterministic data the LLM was given.
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

export async function handleTurn(
  sessionId: string,
  userText: string
): Promise<OrchestratorResult> {
  const session = await loadSession(sessionId);
  const intent = classifyIntent(userText, session.stage);

  console.log(`[ORCHESTRATOR] session=${sessionId} stage=${session.stage} intent=${intent} text="${userText}"`);

  let facts: TurnFacts;

  // Stages where a cancel/check-appointments flow is already in progress.
  // "cancel" or "appointment" appearing in the user's text here (e.g. "yes
  // cancel it" while confirming) must NOT restart the whole flow from
  // scratch — that was the exact bug that made cancellation loop forever,
  // re-asking for the phone number every single turn.
  const midFlowStages = new Set<ConversationSession["stage"]>([
    "awaiting_patient_phone",
    "cancelling_select_appointment",
    "cancelling_confirm",
  ]);
  const alreadyMidFlow = midFlowStages.has(session.stage);

  // -------------------------------------------------------------------
  // Global intents that can interrupt almost any stage
  // -------------------------------------------------------------------
  if (intent === "goodbye") {
    facts = { intent, stage: session.stage, nextStage: "done", action: "goodbye", data: {} };
    session.stage = "done";
  } else if (intent === "greeting" && !resolveSpecialization(userText).confident) {
    // A bare "hello Maya, how are you?" has no medical content — respond
    // with a plain greeting instead of silently defaulting to a
    // "general medicine" DB search (which was firing on every hello and,
    // if that specialization happened to be empty, made it look broken).
    session.stage = "awaiting_symptom_or_request";
    facts = {
      intent,
      stage: "greeting",
      nextStage: "awaiting_symptom_or_request",
      action: "ask_symptom",
      data: {},
    };
  } else if (intent === "check_appointments" && !alreadyMidFlow) {
    session.stage = "checking_appointments";
    facts = { intent, stage: session.stage, nextStage: "awaiting_patient_phone", action: "ask_phone", data: {} };
    session.stage = "awaiting_patient_phone";
    // tag why we're asking for the phone number this time
    (session as any)._phoneReasonIsLookup = true;
  } else if (intent === "cancel_appointment" && !alreadyMidFlow) {
    session.stage = "cancelling_select_appointment";
    facts = { intent, stage: session.stage, nextStage: "awaiting_patient_phone", action: "ask_phone", data: {} };
    session.stage = "awaiting_patient_phone";
    (session as any)._phoneReasonIsCancel = true;
  } else {
    facts = await routeByStage(session, intent, userText);
  }

  await saveSession(session);

  const reply = await phraseResponse(facts);

  return { reply, stage: session.stage, options: facts.data };
}

async function routeByStage(
  session: ConversationSession,
  intent: string,
  userText: string
): Promise<TurnFacts> {
  switch (session.stage) {
    case "greeting":
    case "awaiting_symptom_or_request": {
      const { specialization, matchedKeyword, confident } = resolveSpecialization(userText);
      session.symptomText = userText;
      session.specialization = specialization;

      const doctors = await getDoctorsBySpecialization(specialization);
      session.candidateDoctors = doctors;

      if (doctors.length === 0) {
        console.warn(`[ORCHESTRATOR] No doctors found for specialization="${specialization}" — check DB seeding`);
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

      // This is the important cache-warming step: fetch (and cache) the
      // FULL 7-day slot map right now, in one shot, so every subsequent
      // date/time question in this conversation is a cache read.
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

      // Pure cache read — slot map for this doctor was already cached when
      // the doctor was selected. No DB round-trip here at all.
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
      return {
        intent: intent as any,
        stage: "awaiting_patient_name",
        nextStage: "awaiting_patient_phone",
        action: "ask_phone",
        data: {},
      };
    }

    case "awaiting_patient_phone": {
      // Branch: this phone step is shared by booking, "check appointments",
      // and "cancel appointment" flows — decide which by session flags.
      const phone = extractValidPhone(userText);

      if (!phone) {
        // Never silently accept unparseable input here — this used to store
        // things like "I have already given you my phone number" verbatim
        // as the phone number and crash on insert (varchar(20) overflow).
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_phone",
          data: { retry: true },
        };
      }
      session.patientPhone = phone;

      if ((session as any)._phoneReasonIsLookup) {
        (session as any)._phoneReasonIsLookup = false;
        const appts = await getUpcomingAppointmentsByPhone(phone);
        session.lastAppointments = appts.map((a) => ({
          appointmentId: a.appointmentId,
          doctorName: a.doctorName,
          date: formatDateLabel(a.slotDate as unknown as string),
          time: formatTimeLabel(a.startTime as unknown as string),
          status: a.status,
        }));

        if (session.lastAppointments.length === 0) {
          session.stage = "done";
          return {
            intent: "check_appointments",
            stage: "awaiting_patient_phone",
            nextStage: "done",
            action: "no_appointments",
            data: { phone },
          };
        }

        session.stage = "done";
        return {
          intent: "check_appointments",
          stage: "awaiting_patient_phone",
          nextStage: "done",
          action: "list_appointments",
          data: { appointments: session.lastAppointments },
        };
      }

      if ((session as any)._phoneReasonIsCancel) {
        (session as any)._phoneReasonIsCancel = false;
        const appts = await getUpcomingAppointmentsByPhone(phone);
        session.lastAppointments = appts.map((a) => ({
          appointmentId: a.appointmentId,
          doctorName: a.doctorName,
          date: formatDateLabel(a.slotDate as unknown as string),
          time: formatTimeLabel(a.startTime as unknown as string),
          status: a.status,
        }));

        if (session.lastAppointments.length === 0) {
          session.stage = "done";
          return {
            intent: "cancel_appointment",
            stage: "awaiting_patient_phone",
            nextStage: "done",
            action: "no_appointments",
            data: { phone },
          };
        }

        // Only one appointment on file — skip the "which one?" question
        // entirely and go straight to confirming it. Asking the user to
        // pick from a list of one is just friction, and (combined with the
        // restart-loop bug) was the actual cause of the infinite phone-
        // number loop reported.
        if (session.lastAppointments.length === 1) {
          const only = session.lastAppointments[0];
          (session as any)._appointmentToCancel = only.appointmentId;
          session.stage = "cancelling_confirm";
          return {
            intent: "cancel_appointment",
            stage: "awaiting_patient_phone",
            nextStage: "cancelling_confirm",
            action: "confirm_cancellation",
            data: { doctorName: only.doctorName, date: only.date, time: only.time },
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

      // Default: this is the booking flow — move to final confirmation.
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
        // Try to understand what the user actually wants to change from
        // the same utterance, instead of always assuming "time" (which
        // previously ignored corrections like "no, I said July 5th").
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
        if (dateResult.requestedIso) {
          session.stage = "awaiting_date_selection";
          return {
            intent: intent as any,
            stage: "awaiting_confirmation",
            nextStage: "awaiting_date_selection",
            action: "date_unavailable",
            data: {
              requestedDate: formatDateLabel(dateResult.requestedIso),
              dates: (session.availableDates ?? []).map(formatDateLabel),
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

        // Nothing specific detected in the correction — ask plainly rather
        // than guessing which field ("date"/"time"/"doctor") to reopen.
        session.stage = "awaiting_change_target";
        return {
          intent: intent as any,
          stage: "awaiting_confirmation",
          nextStage: "awaiting_change_target",
          action: "ask_change_target",
          data: {},
        };
      }

      // Any non-"no" answer here is treated as confirmation — deterministic
      // YES_RE already filtered for affirmative language upstream.
      const result = await bookSlot({
        slotId: session.selectedSlotId!,
        doctorId: session.selectedDoctorId!,
        patientName: session.patientName!,
        patientPhone: session.patientPhone!,
        reasonForVisit: session.symptomText,
      });

      if (!result.ok) {
        // Slot was taken between offer and confirmation — re-pull fresh
        // availability (cache already invalidated by the failed attempt's
        // race) so the next turn offers only truly-open times.
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
      const idxMatch = userText.match(/\b(\d)\b/);
      const ordinalMap: Record<string, number> = { first: 0, second: 1, third: 2 };
      let idx: number | null = idxMatch ? parseInt(idxMatch[1], 10) - 1 : null;
      if (idx === null) {
        for (const [w, i] of Object.entries(ordinalMap)) {
          if (userText.toLowerCase().includes(w)) idx = i;
        }
      }
      let chosen = idx !== null ? session.lastAppointments?.[idx] : null;

      // Also allow "cancel the one with Dr. Kapoor" style references.
      if (!chosen) {
        const lower = userText.toLowerCase();
        chosen = session.lastAppointments?.find((a) =>
          lower.includes(a.doctorName.toLowerCase().replace(/^dr\.?\s*/i, ""))
        ) ?? null;
      }

      if (!chosen) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_which_to_cancel",
          data: { appointments: session.lastAppointments ?? [] },
        };
      }

      (session as any)._appointmentToCancel = chosen.appointmentId;
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
      if (intent === "confirm_no") {
        session.stage = "done";
        return {
          intent: intent as any,
          stage: "cancelling_confirm",
          nextStage: "done",
          action: "goodbye",
          data: {},
        };
      }
      const apptId = (session as any)._appointmentToCancel as number;
      await cancelAppointment(apptId);
      // Offer to book a new slot right away — this is what makes "reschedule"
      // actually work end-to-end, since it's handled as cancel-then-rebook.
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
      // Reached from "done"/"booked"/etc. when the user starts a new
      // request. Previously this only returned nextStage in the response
      // data without actually updating session.stage, so every follow-up
      // after finishing a booking/cancellation/lookup just repeated "what
      // symptoms are you having?" forever instead of ever processing the
      // answer. Now we hand the same message straight to the symptom stage
      // instead of wasting a turn just to re-ask for it.
      session.stage = "awaiting_symptom_or_request";
      return routeByStage(session, intent, userText);
    }
  }
}
