import { ConversationStage, Intent } from "./types";
import { containsMonthMention, parseCalendarDateMention } from "./selectors";

/**
 * 100% deterministic intent classification.
 *
 * Rules are evaluated in priority order. Classification is stage-aware
 * because the same utterance means different things in different contexts
 * (e.g. "the second one" is a doctor choice in one stage and a time choice
 * in another). This keeps the LLM completely out of the routing decision.
 */
const BARE_GREETING_RE =
  /^(hi|hello|hey|good morning|good afternoon|good evening)[\s!.]*$/i;
const GREETING_RE = /\b(hi|hello|hey|good (morning|afternoon|evening))\b/i;
const GOODBYE_RE = /\b(bye|goodbye|that'?s all|no thanks|nothing else|thank you,? bye)\b/i;
const YES_RE = /\b(yes|yeah|yup|correct|confirm|sounds good|book it|go ahead|sure)\b/i;
const NO_RE = /\b(no|nope|cancel that|not this one|change|different)\b/i;
const CHECK_APPTS_RE =
  /\b(check|view|see|show|list|look\s*up|find|get)\b[\s\S]{0,80}\b(upcoming\s+|future\s+)?appointments?\b|\b(upcoming|future)\s+appointments?\b|\bmy\s+(upcoming\s+|future\s+)?appointments?\b/i; const RESCHEDULE_RE = /\breschedul(e|ing)\b/i;
const CANCEL_RE = /\bcancel\b/i;
const PHONE_RE = /\b\d{10}\b|\+?\d[\d\s-]{7,14}\d\b/;
const ORDINAL_RE = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/i;
const DATE_WORDS_RE = /\b(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const DATE_NUM_RE = /\b\d{1,2}(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
const TIME_RE = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;

export function classifyIntent(userText: string, stage: ConversationStage): Intent {
  const text = userText.trim();

  if (GOODBYE_RE.test(text)) return "goodbye";
  if (BARE_GREETING_RE.test(text) && stage === "greeting") {
    return "greeting";
  }
  if (RESCHEDULE_RE.test(text)) return "reschedule_appointment";
  if (GREETING_RE.test(text) && stage === "greeting") return "greeting";
  // "reschedule" must be checked before the check-appointments regex, since
  // "reschedule my appointment" also matches "my appointment" and was being
  // misclassified as a read-only lookup (producing confused LLM output with
  // no actual reschedule flow behind it).
  if (CHECK_APPTS_RE.test(text)) return "check_appointments";
  if (CANCEL_RE.test(text)) return "cancel_appointment";

  switch (stage) {
    case "awaiting_doctor_selection":
    case "showing_doctors":
      if (ORDINAL_RE.test(text) || /dr\.?\s?\w+/i.test(text) || /\bnumber\s?\d\b/i.test(text)) {
        return "doctor_selection";
      }
      break;

    case "awaiting_date_selection":
    case "showing_dates":
      if (
        DATE_WORDS_RE.test(text) ||
        DATE_NUM_RE.test(text) ||
        parseCalendarDateMention(text) !== null ||
        ORDINAL_RE.test(text)
      ) {
        return "date_selection";
      }
      break;

    case "awaiting_time_selection":
    case "showing_slots":
      if (TIME_RE.test(text.replace(/\./g, ""))) {
        return "time_selection";
      }
      // A bare ordinal like "5th" is only a slot-position reference if
      // there's no month mention nearby — otherwise it's almost certainly
      // a date ("July 5th") bleeding into this stage, and treating it as
      // "pick slot #5" was the exact bug that booked the wrong day.
      if (ORDINAL_RE.test(text) && !containsMonthMention(text)) {
        return "time_selection";
      }
      break;

    case "awaiting_confirmation":
      if (YES_RE.test(text)) return "confirm_yes";
      if (NO_RE.test(text)) return "confirm_no";
      break;

    case "awaiting_patient_name":
      if (text.length > 0 && !PHONE_RE.test(text)) return "provide_name";
      break;

    case "awaiting_patient_phone":
      if (PHONE_RE.test(text)) return "provide_phone";
      break;

    case "cancelling_select_appointment":
      if (ORDINAL_RE.test(text) || /\bappointment\s?\d\b/i.test(text)) {
        return "doctor_selection"; // reused as "selection made" signal
      }
      break;

    case "cancelling_confirm":
      if (YES_RE.test(text)) return "confirm_yes";
      if (NO_RE.test(text)) return "confirm_no";
      break;
  }

  // Fall through: generic yes/no still useful outside their "home" stage
  if (YES_RE.test(text)) return "confirm_yes";
  if (NO_RE.test(text)) return "confirm_no";

  // Anything else at the start of a conversation, or containing free text
  // about how the patient feels, is treated as a symptom/specialization
  // query — this is deliberately the most common fallback since Maya is a
  // medical receptionist and most first turns describe a complaint.
  if (stage === "greeting" || stage === "awaiting_symptom_or_request") {
    return "symptom_or_specialization_query";
  }

  return "unknown";
}
