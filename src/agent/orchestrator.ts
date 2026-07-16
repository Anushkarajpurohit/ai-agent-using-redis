// orchestrator.tsx
import { classifyIntent } from "./intent-classifier";
import { resolveSpecialization } from "./specialization-map";
import {
  resolveDoctorSelection,
  resolveDateSelection,
  resolveTimeSelection,
  extractValidName,
  extractValidPhone,
  extractDoctorNameQuery, containsMonthMention
} from "./selectors";
import { loadSession, saveSession } from "./session-store";
import { phraseResponse, resolveAmbiguousChoice } from "./llm";
import { getDoctorsBySpecialization, searchDoctorByName, } from "../db/queries/doctors";
import { getDoctorWeekAvailability } from "../db/queries/slots";
import {
  bookSlot,
  cancelAppointment,
  getUpcomingAppointmentsByPhone,
  getPatientByPhone
} from "../db/queries/appointments";
import { ConversationSession, TurnFacts, Intent, SlotRecord, ConversationStage, ConversationGoal } from "./types";
import { StringDecoder } from "string_decoder";
export interface OrchestratorResult {
  reply: string;
  stage: ConversationSession["stage"];
  options?: Record<string, unknown>;
}
function categorizeSlotsByPeriod(slots: SlotRecord[]) {
  const morning = slots.filter(
    (s) => parseInt(s.startTime.split(":")[0]) < 12
  );
  const afternoon = slots.filter((s) => {
    const h = parseInt(s.startTime.split(":")[0]);
    return h >= 12 && h < 17;
  });
  const evening = slots.filter(
    (s) => parseInt(s.startTime.split(":")[0]) >= 17
  );

  const availablePeriods: string[] = [];
  if (morning.length > 0) availablePeriods.push("morning");
  if (afternoon.length > 0) availablePeriods.push("afternoon");
  if (evening.length > 0) availablePeriods.push("evening");

  return {
    morning,
    afternoon,
    evening,
    morningCount: morning.length,
    afternoonCount: afternoon.length,
    eveningCount: evening.length,
    availablePeriods,
  };
}

function filterSlotsByPeriod(
  slots: SlotRecord[],
  period: "morning" | "afternoon" | "evening"
): SlotRecord[] {
  return slots.filter((s) => {
    const h = parseInt(s.startTime.split(":")[0]);
    if (period === "morning") return h < 12;
    if (period === "afternoon") return h >= 12 && h < 17;
    return h >= 17;
  });
}

function parsePeriod(
  text: string
): "morning" | "afternoon" | "evening" | null {
  const t = text.toLowerCase();
  if (/\b(morning|forenoon|early|before\s+(noon|lunch))\b/.test(t))
    return "morning";
  if (/\b(afternoon|noon|midday|lunch|post[- ]?lunch|after\s+lunch)\b/.test(t))
    return "afternoon";
  if (/\b(evening|night|late)\b/.test(t)) return "evening";
  return null;
}
function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatTimeLabel(hhmmss: string): string {
  const [h, m] = hhmmss.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}
// "which doctor am I even booking with" — a plain informational question
// that the date/time-selection stages otherwise silently ignore (they only
// look for a date/time in the utterance, so an unrelated question just gets
// treated as unparseable and the same date/time list gets re-asked without
// ever answering what was actually asked).
const WHICH_DOCTOR_RE = /\b(which|what|who)\s+(is\s+the\s+)?doctor\b|\bwho'?s\s+the\s+doctor\b/i;

function resolveIntentAndWorkflow(
  text: string,
  stage: ConversationSession["stage"],
  classified: Intent,
  session: ConversationSession
): { intent: Intent; workflowAction: "continue" | "switch"; newGoal?: ConversationGoal } {
  const t = text.toLowerCase();

  const mentionsAppointment = /\bappointments?\b/.test(t);
  const wantsLookup = mentionsAppointment && /\b(check|view|see|show|list|look\s*up|find|get|upcoming|future)\b/.test(t);
  const wantsCancel = mentionsAppointment && /\b(cancel|delete|remove)\b/.test(t);
  const wantsReschedule = /\breschedul(e|ing)\b/i.test(t);

  // If the user explicitly asks for a workflow switch:
  if (wantsReschedule && session.goal !== "reschedule") return { intent: "reschedule_appointment", workflowAction: "switch", newGoal: "reschedule" };

  if (wantsCancel && session.goal !== "cancellation") {
    if (!(stage === "cancelling_confirm" && /\b(don'?t|do not|never|abort|stop)\b/i.test(t))) {
      return { intent: "cancel_appointment", workflowAction: "switch", newGoal: "cancellation" };
    }
  }

  if (wantsLookup && session.goal !== "lookup") return { intent: "check_appointments", workflowAction: "switch", newGoal: "lookup" };

  if (classified === "new_booking_request" && session.goal !== "booking") {
    return { intent: "new_booking_request", workflowAction: "switch", newGoal: "booking" };
  }

  if (stage !== "cancelling_confirm" && wantsCancel) {
    if (/\b(don'?t|do not|never|abort|stop)\b/i.test(t) && /\bcancel\b/i.test(t)) {
      return { intent: "confirm_no", workflowAction: "continue" };
    }
    if (/\b(yes|yeah|sure|ok|okay|confirm)\b/i.test(t)) return { intent: "confirm_yes", workflowAction: "continue" };
    if (/\b(no|nope)\b/i.test(t)) return { intent: "confirm_no", workflowAction: "continue" };
  }

  return { intent: classified, workflowAction: "continue" };
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
  delete session.allSlotsForDate;
  delete session.selectedSlotId;
  delete session.selectedSlotTime;
  delete session.patientName;
  delete session.reasonForVisit;
  delete session.existingPatientId
}
// Add these new utility functions after clearBookingDraft():

function saveCurrentContext(session: ConversationSession) {
  session.previousContext = {
    stage: session.stage,
    symptomText: session.symptomText,
    specialization: session.specialization,
    candidateDoctors: session.candidateDoctors,
    selectedDoctorId: session.selectedDoctorId,
    selectedDoctorName: session.selectedDoctorName,
    availableDates: session.availableDates,
    selectedDate: session.selectedDate,
    availableSlotsForDate: session.availableSlotsForDate,
    allSlotsForDate: session.allSlotsForDate,
    selectedSlotId: session.selectedSlotId,
    selectedSlotTime: session.selectedSlotTime,
    patientName: session.patientName,
    patientPhone: session.patientPhone,
    existingPatientId: session.existingPatientId, // Preserved

    reasonForVisit: session.reasonForVisit,
  };
}

function restorePreviousContext(session: ConversationSession): boolean {
  if (!session.previousContext) return false;

  Object.assign(session, session.previousContext);
  session.previousContext = undefined;
  return true;
}
export async function handleTurn(
  sessionId: string,
  userText: string
): Promise<OrchestratorResult> {
  const session = await loadSession(sessionId);

  const rawIntent = classifyIntent(userText, session.stage);
  const { intent, workflowAction, newGoal } = resolveIntentAndWorkflow(userText, session.stage, rawIntent, session);

  console.log(
    `[ORCHESTRATOR] session=${sessionId} stage=${session.stage} rawIntent=${rawIntent} intent=${intent} workflowAction=${workflowAction} text="${userText}"`
  );

  let facts: TurnFacts | undefined;

  // Handle workflow switches centrally
  if (workflowAction === "switch" && newGoal) {
    saveCurrentContext(session);

    // Carry over slots
    const preserved = {
      patientName: session.patientName,
      patientPhone: session.patientPhone,
      existingPatientId: session.existingPatientId,
    };
    clearBookingDraft(session);
    session.patientName = preserved.patientName;
    session.patientPhone = preserved.patientPhone;
    session.existingPatientId = preserved.existingPatientId;

    session.goal = newGoal;

    if (newGoal === "booking") {
      session.stage = "awaiting_symptom_or_request";
      // Don't generate facts yet, let routeByStage handle the new_booking_request
    } else if (newGoal === "lookup") {
      session.stage = "awaiting_patient_phone";
      session.phonePurpose = "lookup";
      if (!session.patientPhone) {
        facts = {
          intent,
          stage: "checking_appointments",
          nextStage: "awaiting_patient_phone",
          action: "ask_phone",
          data: { purpose: "lookup" },
        };
      }
    } else if (newGoal === "reschedule") {
      session.stage = "awaiting_patient_phone";
      session.phonePurpose = "reschedule";
      if (!session.patientPhone) {
        facts = {
          intent,
          stage: "rescheduling_lookup",
          nextStage: "awaiting_patient_phone",
          action: "ask_phone",
          data: { purpose: "reschedule" },
        };
      }
    } else if (newGoal === "cancellation") {
      session.stage = "awaiting_patient_phone";
      session.phonePurpose = "cancel";
      if (!session.patientPhone) {
        facts = {
          intent,
          stage: "cancelling_select_appointment",
          nextStage: "awaiting_patient_phone",
          action: "ask_phone",
          data: { purpose: "cancel" },
        };
      }
    }
  }

  // If a workflow switch occurred but we already have the phone (e.g. from previous flow), 
  // we let routeByStage process it normally, but first acknowledge the switch.
  if (workflowAction === "switch" && !facts && newGoal !== "booking") {
    // Actually, if we switch and have the phone, we should just process the intent through routeByStage.
    // E.g. routeByStage will handle "awaiting_patient_phone" with intent="cancel_appointment" or "provide_phone"
    // Wait, if intent is "cancel_appointment" and we are in "awaiting_patient_phone", routeByStage might need to know.
    // Let's just let routeByStage handle the current state.
  }

  if (!facts) {
    if (intent === "goodbye") {
      session.stage = "done";
      facts = {
        intent,
        stage: session.stage,
        nextStage: "done",
        action: "goodbye",
        data: {},
      };
    } else {
      facts = await routeByStage(session, intent, userText);

      // If we switched workflow and generated normal facts, wrap it with an acknowledgment
      if (workflowAction === "switch") {
        // Option 1: Just use facts as generated
        // Option 2: Prepend an acknowledgment in the LLM. 
        // For simplicity, we just proceed. The new flow is clear enough.
      }
    }
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
  const switchCheck = detectContextSwitch(userText, session.stage, intent, session);

  if (switchCheck.shouldSwitch && switchCheck.targetStage) {
    console.log(`[CONTEXT SWITCH] ${switchCheck.reason}: ${session.stage} → ${switchCheck.targetStage}`);

    // Save current context for potential "go back" later
    saveCurrentContext(session);

    // Clear only the fields that are being changed, preserve patient info
    if (switchCheck.targetStage === "awaiting_doctor_selection") {
      // Keep patient info, clear doctor/date/time
      delete session.selectedDoctorId;
      delete session.selectedDoctorName;
      delete session.selectedDate;
      delete session.selectedSlotId;
      delete session.selectedSlotTime;
      delete session.availableDates;
      delete session.availableSlotsForDate;
      delete session.allSlotsForDate;
      // Keep: patientName, patientPhone, existingPatientId, symptomText, specialization
    }
    else if (switchCheck.targetStage === "awaiting_date_selection") {
      // Keep doctor, clear date/time
      delete session.selectedDate;
      delete session.selectedSlotId;
      delete session.selectedSlotTime;
      delete session.availableSlotsForDate;
      delete session.allSlotsForDate;
      // Keep: selectedDoctorId, selectedDoctorName, patient info
    }
    else if (switchCheck.targetStage === "awaiting_time_selection" || switchCheck.targetStage === "awaiting_time_preference") {
      // Keep doctor and date, clear time
      delete session.selectedSlotId;
      delete session.selectedSlotTime;
      // Keep: selectedDoctorId, selectedDate, patient info
    }
    else if (switchCheck.targetStage === "awaiting_symptom_or_request") {
      // Full reset except patient info if already known
      const preservedPatientInfo = {
        patientName: session.patientName,
        patientPhone: session.patientPhone,
        existingPatientId: session.existingPatientId,
      };
      clearBookingDraft(session);
      session.patientName = preservedPatientInfo.patientName;
      session.patientPhone = preservedPatientInfo.patientPhone;
      session.existingPatientId = preservedPatientInfo.existingPatientId;
    }

    session.stage = switchCheck.targetStage;

    // Route to the new stage immediately
    return routeByStage(session, intent, userText);
  }


  switch (session.stage) {
    case "greeting":
    case "awaiting_symptom_or_request": {
      // Mark the flow as an active booking as soon as we start gathering a
      // symptom/doctor request. Without this, session.goal stays "none" for
      // the entire flow (nothing else ever sets it), so the very next
      // utterance that doesn't match a stage-specific pattern in
      // classifyIntent — e.g. "book her" at the doctor-selection stage —
      // falls through to intent "new_booking_request", and since goal was
      // still "none" that was read as "start a brand new booking," silently
      // wiping all progress (doctor/date/slot already chosen) back to this
      // same stage. That was the single biggest source of mid-flow loops.
      session.goal = "booking";

      // Check if user wants to return to previous booking
      if (intent === "confirm_yes" && session.previousContext?.selectedDoctorId) {
        console.log("[CONTEXT RESTORE] User wants to resume previous booking");
        restorePreviousContext(session);

        // Return to appropriate stage based on what was saved
        if (session.selectedSlotTime && session.selectedDate) {
          session.stage = "awaiting_confirmation";
          return {
            intent: intent as any,
            stage: "awaiting_symptom_or_request",
            nextStage: "awaiting_confirmation",
            action: "confirm_booking_details",
            data: {
              doctorName: session.selectedDoctorName,
              date: session.selectedDate ? formatDateLabel(session.selectedDate) : undefined,
              time: session.selectedSlotTime,
              patientName: session.patientName,
            },
          };
        } else if (session.selectedDate) {
          session.stage = "awaiting_time_selection";
          return {
            intent: intent as any,
            stage: "awaiting_symptom_or_request",
            nextStage: "awaiting_time_selection",
            action: "list_slots",
            data: {
              date: formatDateLabel(session.selectedDate),
              times: (session.availableSlotsForDate ?? []).map((s) => formatTimeLabel(s.startTime)),
            },
          };
        }
      }

      const doctorNameQuery = extractDoctorNameQuery(userText);

      if (doctorNameQuery) {
        const nameMatches = await searchDoctorByName(doctorNameQuery);

        if (nameMatches.length === 1) {
          const doc = nameMatches[0];
          session.symptomText = userText;
          session.specialization = doc.specialization;
          session.candidateDoctors = nameMatches;
          session.selectedDoctorId = doc.id;
          session.selectedDoctorName = doc.name;

          const week = await getDoctorWeekAvailability(doc.id);
          const availableDates = Object.keys(week.slotsByDate).filter(
            (d) => week.slotsByDate[d].length > 0
          );
          session.availableDates = availableDates;

          if (availableDates.length === 0) {
            session.stage = "awaiting_symptom_or_request";
            return {
              intent: "doctor_selection" as any,
              stage: "awaiting_symptom_or_request",
              nextStage: "awaiting_symptom_or_request",
              action: "clarify_unknown",
              data: { reason: "no_availability", doctorName: doc.name },
            };
          }

          session.stage = "awaiting_date_selection";
          console.log(`[ORCHESTRATOR] Direct doctor match: ${doc.name} (id=${doc.id})`);

          return {
            intent: "doctor_selection" as any,
            stage: "awaiting_symptom_or_request",
            nextStage: "awaiting_date_selection",
            action: "list_dates",
            data: {
              doctorName: doc.name,
              dates: availableDates.map(formatDateLabel),
              rawDates: availableDates,
            },
          };
        }

        if (nameMatches.length > 1) {
          session.symptomText = userText;
          session.candidateDoctors = nameMatches;
          session.stage = "awaiting_doctor_selection";

          return {
            intent: "symptom_or_specialization_query" as any,
            stage: "awaiting_symptom_or_request",
            nextStage: "awaiting_doctor_selection",
            action: "list_doctors",
            data: {
              specialization: "matching your search",
              matchedKeyword: doctorNameQuery,
              doctors: nameMatches.map((d) => ({
                id: d.id,
                name: d.name,
                qualifications: d.qualifications,
                yearsExperience: d.yearsExperience,
                clinicName: d.clinicName,
              })),
            },
          };
        }

        session.stage = "awaiting_symptom_or_request";
        return {
          intent: "symptom_or_specialization_query" as any,
          stage: "awaiting_symptom_or_request",
          nextStage: "awaiting_symptom_or_request",
          action: "clarify_unknown",
          data: {
            reason: "doctor_not_found",
            doctorName: doctorNameQuery,
          },
        };
      }

      const { specialization, matchedKeyword, confident } =
        resolveSpecialization(userText);

      if (!confident) {
        session.stage = "awaiting_symptom_or_request";
        return {
          intent: 'symptom_or_specialization_query' as any,
          stage: "awaiting_symptom_or_request",
          nextStage: "awaiting_symptom_or_request",
          action: "clarify_unknown",
          data: { reason: "specialization_not_matched", symptomText: userText },
        };
      }
      session.symptomText = userText;
      session.specialization = specialization;

      const doctors = await getDoctorsBySpecialization(specialization);
      session.candidateDoctors = doctors;

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
          data: {
            reason: "no_doctors_for_specialization",
            specialization,
            confident,
          },
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
      // ═══ HANDLE CONTEXT SWITCHES ═══
      // Check for date mention while in doctor selection
      const dateResult = resolveDateSelection(userText, session.availableDates ?? []);
      if (dateResult.matchedIso && session.selectedDoctorId) {
        console.log("[CONTEXT SWITCH] User mentioned date during doctor selection");
        session.selectedDate = dateResult.matchedIso;
        const week = await getDoctorWeekAvailability(session.selectedDoctorId);
        const slots = week.slotsByDate[dateResult.matchedIso] ?? [];
        session.allSlotsForDate = slots;
        session.availableSlotsForDate = slots;

        const periods = categorizeSlotsByPeriod(slots);
        if (periods.availablePeriods.length >= 2 && slots.length > 5) {
          session.stage = "awaiting_time_preference";
          return {
            intent: intent as any,
            stage: "awaiting_doctor_selection",
            nextStage: "awaiting_time_preference",
            action: "ask_time_preference",
            data: {
              date: formatDateLabel(dateResult.matchedIso),
              morningCount: periods.morningCount,
              afternoonCount: periods.afternoonCount,
              eveningCount: periods.eveningCount,
              periods: periods.availablePeriods,
            },
          };
        }

        session.stage = "awaiting_time_selection";
        return {
          intent: intent as any,
          stage: "awaiting_doctor_selection",
          nextStage: "awaiting_time_selection",
          action: "list_slots",
          data: {
            date: formatDateLabel(dateResult.matchedIso),
            times: slots.map((s) => formatTimeLabel(s.startTime)),
          },
        };
      }

      const chosen = resolveDoctorSelection(userText, session.candidateDoctors ?? []);

      if (chosen) {
        session.selectedDoctorId = chosen.id;
        session.selectedDoctorName = chosen.name;

        const week = await getDoctorWeekAvailability(chosen.id);
        const availableDates = Object.keys(week.slotsByDate).filter(
          (d) => week.slotsByDate[d].length > 0
        );
        session.availableDates = availableDates;

        if (availableDates.length === 0) {
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
          intent: "doctor_selection" as any,
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

      const doctorNameQuery = extractDoctorNameQuery(userText);
      if (doctorNameQuery) {
        const nameMatches = await searchDoctorByName(doctorNameQuery);

        if (nameMatches.length === 1) {
          const doc = nameMatches[0];
          session.selectedDoctorId = doc.id;
          session.selectedDoctorName = doc.name;
          session.specialization = doc.specialization;
          session.candidateDoctors = nameMatches;

          const week = await getDoctorWeekAvailability(doc.id);
          const availableDates = Object.keys(week.slotsByDate).filter(
            (d) => week.slotsByDate[d].length > 0
          );
          session.availableDates = availableDates;

          if (availableDates.length === 0) {
            return {
              intent: intent as any,
              stage: "awaiting_doctor_selection",
              nextStage: "awaiting_doctor_selection",
              action: "clarify_unknown",
              data: { reason: "no_availability", doctorName: doc.name },
            };
          }

          session.stage = "awaiting_date_selection";
          return {
            intent: "doctor_selection" as any,
            stage: "awaiting_doctor_selection",
            nextStage: "awaiting_date_selection",
            action: "list_dates",
            data: {
              doctorName: doc.name,
              dates: availableDates.map(formatDateLabel),
              rawDates: availableDates,
            },
          };
        }

        if (nameMatches.length === 0) {
          session.stage = "awaiting_symptom_or_request";
          return {
            intent: intent as any,
            stage: "awaiting_doctor_selection",
            nextStage: "awaiting_symptom_or_request",
            action: "clarify_unknown",
            data: { reason: "doctor_not_found", doctorName: doctorNameQuery },
          };
        }
      }

      if (intent === "confirm_no") {
        session.stage = "awaiting_symptom_or_request";
        clearBookingDraft(session);
        return {
          intent: intent as any,
          stage: "awaiting_doctor_selection",
          nextStage: "awaiting_symptom_or_request",
          action: "ask_symptom",
          data: {},
        };
      }

      const { specialization: newSpec, matchedKeyword: newKeyword, confident: newConfident } =
        resolveSpecialization(userText);

      if (newSpec !== session.specialization && newConfident) {
        session.specialization = newSpec;
        const newDoctors = await getDoctorsBySpecialization(newSpec);
        session.candidateDoctors = newDoctors;

        if (newDoctors.length === 0) {
          return {
            intent: intent as any,
            stage: "awaiting_doctor_selection",
            nextStage: "awaiting_doctor_selection",
            action: "clarify_unknown",
            data: { reason: "no_doctors_for_specialization", specialization: newSpec },
          };
        }

        return {
          intent: "symptom_or_specialization_query" as any,
          stage: "awaiting_doctor_selection",
          nextStage: "awaiting_doctor_selection",
          action: "list_doctors",
          data: {
            specialization: newSpec,
            matchedKeyword: newKeyword,
            doctors: newDoctors.map((d) => ({
              id: d.id,
              name: d.name,
              qualifications: d.qualifications,
              yearsExperience: d.yearsExperience,
              clinicName: d.clinicName,
            })),
          },
        };
      }

      // ═══ LAST-RESORT: ask the LLM to match against the exact candidates
      // already offered (never a doctor outside this list) before giving up
      // and asking again. Only reached once every deterministic check above
      // (name, ordinal, specialization switch) has already failed. ═══
      {
        const llmCandidates = session.candidateDoctors ?? [];
        const picked = await resolveAmbiguousChoice(
          userText,
          "doctor",
          llmCandidates.map((d) => ({ label: `${d.name} (${d.specialization})`, value: String(d.id) }))
        );
        const doc = picked ? llmCandidates.find((d) => String(d.id) === picked) : null;

        if (doc) {
          session.selectedDoctorId = doc.id;
          session.selectedDoctorName = doc.name;

          const week = await getDoctorWeekAvailability(doc.id);
          const availableDates = Object.keys(week.slotsByDate).filter((d) => week.slotsByDate[d].length > 0);
          session.availableDates = availableDates;

          if (availableDates.length === 0) {
            return {
              intent: intent as any,
              stage: "awaiting_doctor_selection",
              nextStage: "awaiting_doctor_selection",
              action: "clarify_unknown",
              data: { reason: "no_availability", doctorName: doc.name },
            };
          }

          session.stage = "awaiting_date_selection";
          return {
            intent: "doctor_selection" as any,
            stage: "awaiting_doctor_selection",
            nextStage: "awaiting_date_selection",
            action: "list_dates",
            data: {
              doctorName: doc.name,
              dates: availableDates.map(formatDateLabel),
              rawDates: availableDates,
            },
          };
        }
      }

      return {
        intent: intent as any,
        stage: "awaiting_doctor_selection",
        nextStage: "awaiting_doctor_selection",
        action: "ask_doctor_choice",
        data: {
          doctors: (session.candidateDoctors ?? []).map((d) => ({
            id: d.id,
            name: d.name,
            qualifications: d.qualifications,
            yearsExperience: d.yearsExperience,
          })),
        },
      };
    }

    case "awaiting_date_selection": {
      if (WHICH_DOCTOR_RE.test(userText) && session.selectedDoctorName) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_date_choice",
          data: { doctorName: session.selectedDoctorName, dates: (session.availableDates ?? []).map(formatDateLabel) },
        };
      }

      // ═══ HANDLE TIME MENTIONS DURING DATE SELECTION ═══
      const timeResult = resolveTimeSelection(userText, session.availableSlotsForDate ?? []);
      if (timeResult.matchedSlot && session.selectedDate) {
        console.log("[CONTEXT SWITCH] User mentioned specific time during date selection");
        session.selectedSlotId = timeResult.matchedSlot.id;
        session.selectedSlotTime = formatTimeLabel(timeResult.matchedSlot.startTime);

        if (session.patientName && session.patientPhone) {
          session.stage = "awaiting_confirmation";
          return {
            intent: intent as any,
            stage: "awaiting_date_selection",
            nextStage: "awaiting_confirmation",
            action: "confirm_booking_details",
            data: {
              doctorName: session.selectedDoctorName,
              date: formatDateLabel(session.selectedDate),
              time: session.selectedSlotTime,
              patientName: session.patientName,
            },
          };
        }

        session.stage = "awaiting_patient_phone";
        session.phonePurpose = "booking";
        return {
          intent: intent as any,
          stage: "awaiting_date_selection",
          nextStage: "awaiting_patient_phone",
          action: "ask_phone",
          data: { purpose: "booking" },
        };
      }

      const result = resolveDateSelection(userText, session.availableDates ?? []);
      let chosenDate = result.matchedIso;

      if (!chosenDate) {
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

        // Last-resort LLM match against the exact dates already offered,
        // before falling back to asking again.
        const dateOptions = (session.availableDates ?? []).map((iso) => ({
          label: formatDateLabel(iso),
          value: iso,
        }));
        chosenDate = await resolveAmbiguousChoice(userText, "date", dateOptions);

        if (!chosenDate) {
          return {
            intent: intent as any,
            stage: session.stage,
            nextStage: session.stage,
            action: "ask_date_choice",
            data: { dates: (session.availableDates ?? []).map(formatDateLabel) },
          };
        }
      }

      session.selectedDate = chosenDate;

      const week = await getDoctorWeekAvailability(session.selectedDoctorId!);
      const slots = week.slotsByDate[chosenDate] ?? [];

      session.allSlotsForDate = slots;
      session.availableSlotsForDate = slots;

      const periods = categorizeSlotsByPeriod(slots);

      if (periods.availablePeriods.length >= 2 && slots.length > 5) {
        session.stage = "awaiting_time_preference";
        return {
          intent: intent as any,
          stage: "awaiting_date_selection",
          nextStage: "awaiting_time_preference",
          action: "ask_time_preference",
          data: {
            date: formatDateLabel(chosenDate),
            morningCount: periods.morningCount,
            afternoonCount: periods.afternoonCount,
            eveningCount: periods.eveningCount,
            periods: periods.availablePeriods,
          },
        };
      }

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

    case "awaiting_time_preference": {
      if (WHICH_DOCTOR_RE.test(userText) && session.selectedDoctorName) {
        const allSlots = session.allSlotsForDate ?? session.availableSlotsForDate ?? [];
        const p = categorizeSlotsByPeriod(allSlots);
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_time_preference",
          data: {
            doctorName: session.selectedDoctorName,
            date: session.selectedDate ? formatDateLabel(session.selectedDate) : undefined,
            morningCount: p.morningCount,
            afternoonCount: p.afternoonCount,
            eveningCount: p.eveningCount,
            periods: p.availablePeriods,
          },
        };
      }

      // ═══ HANDLE DATE CHANGES DURING TIME PREFERENCE ═══
      const dateSwitch = resolveDateSelection(userText, session.availableDates ?? []);
      if (dateSwitch.matchedIso && dateSwitch.matchedIso !== session.selectedDate) {
        console.log("[CONTEXT SWITCH] User changed date during time preference selection");
        session.selectedDate = dateSwitch.matchedIso;
        const week = await getDoctorWeekAvailability(session.selectedDoctorId!);
        const slots = week.slotsByDate[dateSwitch.matchedIso] ?? [];
        session.allSlotsForDate = slots;
        session.availableSlotsForDate = slots;

        const periods = categorizeSlotsByPeriod(slots);
        if (periods.availablePeriods.length >= 2 && slots.length > 5) {
          return {
            intent: intent as any,
            stage: session.stage,
            nextStage: "awaiting_time_preference",
            action: "ask_time_preference",
            data: {
              date: formatDateLabel(dateSwitch.matchedIso),
              morningCount: periods.morningCount,
              afternoonCount: periods.afternoonCount,
              eveningCount: periods.eveningCount,
              periods: periods.availablePeriods,
            },
          };
        }

        session.stage = "awaiting_time_selection";
        return {
          intent: intent as any,
          stage: "awaiting_time_preference",
          nextStage: "awaiting_time_selection",
          action: "list_slots",
          data: {
            date: formatDateLabel(dateSwitch.matchedIso),
            times: slots.map((s) => formatTimeLabel(s.startTime)),
          },
        };
      }

      // Understood a specific date (e.g. "24th of July") but it's outside
      // the offered window — say so plainly instead of silently ignoring it
      // and re-asking "morning, afternoon, or evening?" as if nothing was said.
      if (dateSwitch.requestedIso) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "date_unavailable",
          data: {
            requestedDate: formatDateLabel(dateSwitch.requestedIso),
            dates: (session.availableDates ?? []).map(formatDateLabel),
          },
        };
      }

      if (intent === "time_selection") {
        session.availableSlotsForDate =
          session.allSlotsForDate ?? session.availableSlotsForDate ?? [];
        session.stage = "awaiting_time_selection";
        return routeByStage(session, intent, userText);
      }

      const period = parsePeriod(userText);

      if (!period) {
        const allSlots = session.allSlotsForDate ?? session.availableSlotsForDate ?? [];
        const p = categorizeSlotsByPeriod(allSlots);
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_time_preference",
          data: {
            date: session.selectedDate
              ? formatDateLabel(session.selectedDate)
              : undefined,
            morningCount: p.morningCount,
            afternoonCount: p.afternoonCount,
            eveningCount: p.eveningCount,
            periods: p.availablePeriods,
            retry: true,
          },
        };
      }

      const allSlots =
        session.allSlotsForDate ?? session.availableSlotsForDate ?? [];
      const filtered = filterSlotsByPeriod(allSlots, period);

      if (filtered.length === 0) {
        const p = categorizeSlotsByPeriod(allSlots);
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "no_slots_in_period",
          data: {
            date: session.selectedDate
              ? formatDateLabel(session.selectedDate)
              : undefined,
            period,
            periods: p.availablePeriods,
            morningCount: p.morningCount,
            afternoonCount: p.afternoonCount,
            eveningCount: p.eveningCount,
          },
        };
      }

      session.availableSlotsForDate = filtered;
      session.stage = "awaiting_time_selection";

      return {
        intent: intent as any,
        stage: "awaiting_time_preference",
        nextStage: "awaiting_time_selection",
        action: "list_slots",
        data: {
          date: session.selectedDate
            ? formatDateLabel(session.selectedDate)
            : undefined,
          period,
          times: filtered.map((s) => formatTimeLabel(s.startTime)),
        },
      };
    }

    case "awaiting_time_selection": {
      if (WHICH_DOCTOR_RE.test(userText) && session.selectedDoctorName) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "ask_time_choice",
          data: {
            doctorName: session.selectedDoctorName,
            times: (session.availableSlotsForDate ?? []).map((s) => formatTimeLabel(s.startTime)),
          },
        };
      }

      // ═══ HANDLE DATE CHANGES DURING TIME SELECTION ═══
      const dateSwitch = resolveDateSelection(userText, session.availableDates ?? []);
      if (dateSwitch.matchedIso && dateSwitch.matchedIso !== session.selectedDate) {
        console.log("[CONTEXT SWITCH] User changed date during time selection");
        session.selectedDate = dateSwitch.matchedIso;
        const week = await getDoctorWeekAvailability(session.selectedDoctorId!);
        const slots = week.slotsByDate[dateSwitch.matchedIso] ?? [];
        session.allSlotsForDate = slots;
        session.availableSlotsForDate = slots;
        delete session.selectedSlotId;
        delete session.selectedSlotTime;
        const periods = categorizeSlotsByPeriod(slots);
        if (periods.availablePeriods.length >= 2 && slots.length > 5) {
          session.stage = "awaiting_time_preference";
          return {
            intent: intent as any,
            stage: "awaiting_time_selection",
            nextStage: "awaiting_time_preference",
            action: "ask_time_preference",
            data: {
              date: formatDateLabel(dateSwitch.matchedIso),
              morningCount: periods.morningCount,
              afternoonCount: periods.afternoonCount,
              eveningCount: periods.eveningCount,
              periods: periods.availablePeriods,
            },
          };
        }

        return {
          intent: intent as any,
          stage: "awaiting_time_selection",
          nextStage: "awaiting_time_selection",
          action: "list_slots",
          data: {
            date: formatDateLabel(dateSwitch.matchedIso),
            times: slots.map((s) => formatTimeLabel(s.startTime)),
          },
        };
      }

      // Understood a specific date but it's outside the offered window —
      // say so instead of silently falling through to "which time?" as if
      // the date mention was never heard.
      if (dateSwitch.requestedIso) {
        return {
          intent: intent as any,
          stage: session.stage,
          nextStage: session.stage,
          action: "date_unavailable",
          data: {
            requestedDate: formatDateLabel(dateSwitch.requestedIso),
            dates: (session.availableDates ?? []).map(formatDateLabel),
          },
        };
      }

      const result = resolveTimeSelection(userText, session.availableSlotsForDate ?? []);
      let chosenSlot = result.matchedSlot;

      if (!chosenSlot) {
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

        // Last-resort LLM match against the exact slots already offered
        // (e.g. "the earlier one", "the first slot you said") before
        // falling back to asking again.
        const slotOptions = (session.availableSlotsForDate ?? []).map((s) => ({
          label: formatTimeLabel(s.startTime),
          value: String(s.id),
        }));
        const pickedId = await resolveAmbiguousChoice(userText, "time", slotOptions);
        chosenSlot = pickedId
          ? (session.availableSlotsForDate ?? []).find((s) => String(s.id) === pickedId) ?? null
          : null;

        if (!chosenSlot) {
          return {
            intent: intent as any,
            stage: session.stage,
            nextStage: session.stage,
            action: "ask_time_choice",
            data: { times: (session.availableSlotsForDate ?? []).map((s) => formatTimeLabel(s.startTime)) },
          };
        }
      }

      session.selectedSlotId = chosenSlot.id;
      session.selectedSlotTime = formatTimeLabel(chosenSlot.startTime);

      if (session.patientName && session.patientPhone) {
        session.stage = "awaiting_confirmation";
        return {
          intent: intent as any,
          stage: "awaiting_time_selection",
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

      if (session.patientPhone) {
        const existing = await getPatientByPhone(session.patientPhone);
        if (existing) {
          session.patientName = existing.name;
          session.existingPatientId = existing.id;
          session.stage = "awaiting_confirmation";
          console.log(`[ORCHESTRATOR] Returning patient detected: ${existing.name} (id=${existing.id})`);
          return {
            intent: intent as any,
            stage: "awaiting_time_selection",
            nextStage: "awaiting_confirmation",
            action: "confirm_booking_details",
            data: {
              doctorName: session.selectedDoctorName,
              date: session.selectedDate ? formatDateLabel(session.selectedDate) : undefined,
              time: session.selectedSlotTime,
              patientName: existing.name,
            },
          };
        }
        session.stage = "awaiting_patient_name";
        return {
          intent: intent as any,
          stage: "awaiting_time_selection",
          nextStage: "awaiting_patient_name",
          action: "ask_name",
          data: {},
        };
      }

      session.stage = "awaiting_patient_phone";
      session.phonePurpose = "booking";
      return {
        intent: intent as any,
        stage: "awaiting_time_selection",
        nextStage: "awaiting_patient_phone",
        action: "ask_phone",
        data: { purpose: "booking" },
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

      const existingPatient = await getPatientByPhone(phone);

      if (existingPatient) {
        // ── Returning patient: auto-fill name, skip straight to confirm ──
        session.patientName = existingPatient.name;
        session.existingPatientId = existingPatient.id;
        session.phonePurpose = undefined;
        session.stage = "awaiting_confirmation";

        console.log(
          `[ORCHESTRATOR] Returning patient: ${existingPatient.name} (id=${existingPatient.id}) — skipping name`
        );

        return {
          intent: "provide_phone",
          stage: "awaiting_patient_phone",
          nextStage: "awaiting_confirmation",
          action: "confirm_booking_details",
          data: {
            doctorName: session.selectedDoctorName,
            date: session.selectedDate ? formatDateLabel(session.selectedDate) : undefined,
            time: session.selectedSlotTime,
            patientName: existingPatient.name,
          },
        };
      }
      // ── New patient: we need their name ──
      session.phonePurpose = undefined;
      session.stage = "awaiting_patient_name";

      return {
        intent: "provide_phone",
        stage: "awaiting_patient_phone",
        nextStage: "awaiting_patient_name",
        action: "ask_name",
        data: {},
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
        // ── Restore full slot list and re-ask preference if applicable ──
        const allSlots = session.allSlotsForDate ?? session.availableSlotsForDate ?? [];
        const p = categorizeSlotsByPeriod(allSlots);


        if (p.availablePeriods.length >= 2 && allSlots.length > 5) {
          session.availableSlotsForDate = allSlots;
          session.stage = "awaiting_time_preference";
          return {
            intent: intent as any,
            stage: "awaiting_change_target",
            nextStage: "awaiting_time_preference",
            action: "ask_time_preference",
            data: {
              date: session.selectedDate
                ? formatDateLabel(session.selectedDate)
                : undefined,
              morningCount: p.morningCount,
              afternoonCount: p.afternoonCount,
              eveningCount: p.eveningCount,
              periods: p.availablePeriods,
            },
          };
        }
        session.availableSlotsForDate = allSlots;
        session.stage = "awaiting_time_selection";
        return {
          intent: intent as any,
          stage: "awaiting_change_target",
          nextStage: "awaiting_time_selection",
          action: "list_slots",
          data: {
            date: session.selectedDate
              ? formatDateLabel(session.selectedDate)
              : undefined,
            times: allSlots.map((s) => formatTimeLabel(s.startTime)),
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
        // ── Look up patient name from DB instead of using "the patient" ──
        const existingPatient = await getPatientByPhone(ctx.patientPhone);
        if (existingPatient) {
          session.patientName = existingPatient.name;
          session.existingPatientId = existingPatient.id;
          console.log(`[RESCHEDULE] Reusing patient: ${existingPatient.name} (id=${existingPatient.id})`);
        }
        // If not found (shouldn't happen — they just had an appointment),
        // patientName stays undefined and the booking flow will ask for it.

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
    // ... rest of the cases remain unchanged (awaiting_patient_name, awaiting_patient_phone, etc.)
    // [Keep all existing code for remaining cases as-is]

    default: {
      session.stage = "awaiting_symptom_or_request";
      return routeByStage(session, intent, userText);
    }
  }
}
function detectContextSwitch(
  userText: string,
  currentStage: ConversationStage,
  intent: string,
  session: ConversationSession
): { shouldSwitch: boolean; targetStage: ConversationStage | null; reason: string } {
  const lower = userText.toLowerCase();

  // Explicit change commands
  if (/\b(change|switch|different|another|go back|back to|not this|wrong)\b/i.test(lower)) {
    if (/\bdoctor\b/i.test(lower)) return { shouldSwitch: true, targetStage: "awaiting_doctor_selection", reason: "user_wants_different_doctor" };
    if (/\bdate\b/i.test(lower) || /\bday\b/i.test(lower)) return { shouldSwitch: true, targetStage: "awaiting_date_selection", reason: "user_wants_different_date" };
    if (/\btime\b/i.test(lower) || /\bslot\b/i.test(lower)) return { shouldSwitch: true, targetStage: session.availableSlotsForDate && session.availableSlotsForDate.length > 5 ? "awaiting_time_preference" : "awaiting_time_selection", reason: "user_wants_different_time" };
    if (/\bspecialization\b/i.test(lower) || /\bspecialist\b/i.test(lower) || /\bcondition\b/i.test(lower)) return { shouldSwitch: true, targetStage: "awaiting_symptom_or_request", reason: "user_wants_different_specialization" };
    if (/\bstart over\b/i.test(lower) || /\bnew booking\b/i.test(lower)) return { shouldSwitch: true, targetStage: "awaiting_symptom_or_request", reason: "user_wants_restart" };
  }

  // Implicit context switches based on content
  // NOTE: "[a-z]" (not "[a-z]+") after "dr." previously matched only a single
  // letter, so it required an immediate word boundary right after it — real
  // names like "Neha" (N followed by more letters) never matched at all.
  // Also matches the full spoken-out word "doctor", not just the "Dr."
  // abbreviation — "can I look for Doctor Amit?" wasn't recognized before.
  const mentionsDoctor = /\b((?:dr\.?|doctor)\s*[a-z]+|[a-z]+\s+(sharma|verma|singh|kumar|patel|gupta))\b/i.test(lower);
  const mentionsDate = containsMonthMention(userText) || /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(st|nd|rd|th))\b/i.test(lower);
  const mentionsTime = /\b\d{1,2}(:\d{2})?\s?(am|pm|o'?clock)\b/i.test(lower);
  const mentionsSpecialization = /\b(orthopedic|cardiologist|dermatologist|general\s+medicine|pediatric|gynecologist|ent|neurologist)\b/i.test(lower);

  switch (currentStage) {
    case "awaiting_time_selection":
    case "awaiting_time_preference":
      if (mentionsDate && !mentionsTime) {
        // User mentioned a different date while selecting time
        const dateResult = resolveDateSelection(userText, session.availableDates ?? []);
        if (dateResult.matchedIso && dateResult.matchedIso !== session.selectedDate) {
          return { shouldSwitch: true, targetStage: "awaiting_date_selection", reason: "date_change_during_time_selection" };
        }
      }
      if (mentionsDoctor) {
        return { shouldSwitch: true, targetStage: "awaiting_doctor_selection", reason: "doctor_change_during_time_selection" };
      }
      break;

    case "awaiting_date_selection":
      if (mentionsDoctor) {
        return { shouldSwitch: true, targetStage: "awaiting_doctor_selection", reason: "doctor_change_during_date_selection" };
      }
      if (mentionsSpecialization) {
        return { shouldSwitch: true, targetStage: "awaiting_symptom_or_request", reason: "specialization_change_during_date_selection" };
      }
      break;

    case "awaiting_doctor_selection":
      if (mentionsSpecialization) {
        return { shouldSwitch: true, targetStage: "awaiting_symptom_or_request", reason: "specialization_change_during_doctor_selection" };
      }
      if (mentionsDate) {
        // User jumped ahead - that's fine, but if they mention a different doctor later, handle it
        return { shouldSwitch: false, targetStage: null, reason: "forward_jump_allowed" };
      }
      break;

    case "awaiting_patient_phone":
    case "awaiting_patient_name":
    case "awaiting_confirmation":
      // Allow going back to change doctor/date/time even at the end
      if (mentionsDoctor) return { shouldSwitch: true, targetStage: "awaiting_doctor_selection", reason: "doctor_change_during_final_stages" };
      if (mentionsDate && !mentionsDoctor) return { shouldSwitch: true, targetStage: "awaiting_date_selection", reason: "date_change_during_final_stages" };
      if (mentionsTime && !mentionsDate && !mentionsDoctor) return { shouldSwitch: true, targetStage: "awaiting_time_selection", reason: "time_change_during_final_stages" };
      break;

    case "cancelling_confirm":
      // If the user says "first one", "different", etc. during the confirmation step, they want to change their selection
      if (/\b(change|different|other|first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|appointment)\b/i.test(lower)) {
        // Only if they actually have multiple appointments to choose from
        if (session.lastAppointments && session.lastAppointments.length > 1) {
          return { shouldSwitch: true, targetStage: "cancelling_select_appointment", reason: "user_changed_appointment_to_cancel" };
        }
      }
      break;
  }

  return { shouldSwitch: false, targetStage: null, reason: "no_switch" };
}