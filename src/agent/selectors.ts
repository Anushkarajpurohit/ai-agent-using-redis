import { DoctorRecord, SlotRecord } from "./types";
import { and, eq, ilike } from "drizzle-orm";
import { db } from "../db/client";
import { doctors } from "../db/schema";
// ---------------------------------------------------------------------------
// Ordinal helpers
// ---------------------------------------------------------------------------

// Used for doctor/time LIST POSITION only ("the second one", "number 3").
// Deliberately excludes bare digit-suffix forms like "5th" here — those are
// ambiguous with calendar dates ("July 5th") and are handled separately.
const WORD_ONLY_ORDINALS: Record<string, number> = {
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4,
};

function findWordOrdinalIndex(text: string): number | null {
  const lower = text.toLowerCase();
  for (const [word, idx] of Object.entries(WORD_ONLY_ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return idx;
  }
  return null;
}

// Broader ordinal matcher (includes "5th", "number 3", bare "3") — safe to
// use for doctor selection where date-confusion isn't a real risk.
const DIGIT_ORDINALS: Record<string, number> = {
  "1st": 0, "2nd": 1, "3rd": 2, "4th": 3, "5th": 4,
};

function findOrdinalIndex(text: string): number | null {
  const wordIdx = findWordOrdinalIndex(text);
  if (wordIdx !== null) return wordIdx;

  const lower = text.toLowerCase();
  for (const [token, idx] of Object.entries(DIGIT_ORDINALS)) {
    if (new RegExp(`\\b${token}\\b`).test(lower)) return idx;
  }
  const numMatch = lower.match(/\bnumber\s?(\d)\b/) || lower.match(/^\s*(\d)\s*$/);
  if (numMatch) return parseInt(numMatch[1], 10) - 1;
  return null;
}

// ---------------------------------------------------------------------------
// Doctor selection
// ---------------------------------------------------------------------------

const AFFIRMATIVE_OR_PRONOUN_RE =
  /\b(yes|yeah|yup|sure|correct|confirm|book( it| her| him| them)?|her|him|them|that one|go ahead|please book|ok|okay)\b/i;

/** Resolve which doctor the user meant: by name match first, else ordinal position,
 *  else — if there's only one candidate on offer — a plain affirmative/pronoun ("yes", "book her"). */
export function resolveDoctorSelection(
  userText: string,
  candidates: DoctorRecord[]
): DoctorRecord | null {
  const lower = userText.toLowerCase();

  const byName = candidates.find((d) =>
    lower.includes(d.name.toLowerCase().replace(/^dr\.?\s*/i, ""))
  );
  if (byName) return byName;

  const idx = findOrdinalIndex(userText);
  if (idx !== null && candidates[idx]) return candidates[idx];

  if (candidates.length === 1 && AFFIRMATIVE_OR_PRONOUN_RE.test(lower)) {
    // "book" and "yes" match too loosely to just trust blindly — "Book
    // appointment with Dr. Neha Kapoor" also matches "book", but the user
    // is explicitly naming a DIFFERENT doctor than the one on offer. Don't
    // let the loose affirmative match silently override an explicit name
    // that doesn't belong to this candidate — let the caller fall through
    // to a fresh name lookup instead.
    const explicitName = extractDoctorNameQuery(userText);
    if (explicitName) {
      const candidateName = candidates[0].name.toLowerCase().replace(/^dr\.?\s*/i, "");
      if (!candidateName.includes(explicitName.toLowerCase())) {
        return null;
      }
    }
    return candidates[0];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Calendar date parsing — this is the piece that was missing entirely.
// Runs BEFORE any ordinal/list-position logic so "July 5th" is always read
// as the calendar date July 5, never as "5th item in the list".
// ---------------------------------------------------------------------------

const MONTHS = [
  { name: "january", abbr: "jan", index: 0 },
  { name: "february", abbr: "feb", index: 1 },
  { name: "march", abbr: "mar", index: 2 },
  { name: "april", abbr: "apr", index: 3 },
  { name: "may", abbr: "may", index: 4 },
  { name: "june", abbr: "jun", index: 5 },
  { name: "july", abbr: "jul", index: 6 },
  { name: "august", abbr: "aug", index: 7 },
  { name: "september", abbr: "sep", index: 8 },
  { name: "october", abbr: "oct", index: 9 },
  { name: "november", abbr: "nov", index: 10 },
  { name: "december", abbr: "dec", index: 11 },
];

const MONTH_ALTERNATION = MONTHS.map((m) => `${m.name}|${m.abbr}`).join("|");
// day-then-month: "12th of July", "5 July", "5th Jul"
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s*)?(${MONTH_ALTERNATION})\\b`, "i");
// month-then-day: "July 5th", "Jul 12"
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_ALTERNATION})\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");
const MONTH_MENTION_RE = new RegExp(`\\b(${MONTH_ALTERNATION})\\b`, "i");

function monthIndexFromToken(token: string): number {
  const lower = token.toLowerCase();
  const found = MONTHS.find((m) => m.name === lower || m.abbr === lower);
  return found ? found.index : -1;
}

export function containsMonthMention(text: string): boolean {
  return MONTH_MENTION_RE.test(text);
}
export function extractDoctorNameQuery(text: string): string | null {
  // Match "Dr." / "Dr" / "Doctor" followed by one or two name words
  const match = text.match(
    /\b(?:dr\.?|doctor)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i
  );
  if (match) return match[1].trim();

  // Match "appointment with <Name>" / "book with <Name>"
  const withMatch = text.match(
    /\b(?:with|see|visit|consult)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/
  );
  if (withMatch) return withMatch[1].trim();

  return null;
}

function cleanDoctorNameQuery(raw: string): string | null {
  const cleaned = raw
    .replace(
      /\b(?:appointment|booking|book|schedule|please|today|tomorrow|on|at|for)\b.*$/i,
      ""
    )
    .replace(/[^\w\s.'-]/g, "")
    .trim();

  return cleaned.length >= 2 ? cleaned : null;
}
/** Parse an explicit calendar date mention ("12th of July", "July 5th", "5 Jul") into an ISO date string. */
export function parseCalendarDateMention(text: string, reference: Date = new Date()): string | null {
  let day: number | null = null;
  let monthIdx: number | null = null;

  const dm = text.match(DAY_MONTH_RE);
  if (dm) {
    day = parseInt(dm[1], 10);
    monthIdx = monthIndexFromToken(dm[2]);
  } else {
    const md = text.match(MONTH_DAY_RE);
    if (md) {
      monthIdx = monthIndexFromToken(md[1]);
      day = parseInt(md[2], 10);
    }
  }

  if (day === null || monthIdx === null || monthIdx < 0 || day < 1 || day > 31) return null;

  const refYearStart = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  let candidate = new Date(reference.getFullYear(), monthIdx, day);
  if (candidate < refYearStart) {
    candidate = new Date(reference.getFullYear() + 1, monthIdx, day);
  }
  const y = candidate.getFullYear();
  const m = String(candidate.getMonth() + 1).padStart(2, "0");
  const d = String(candidate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;

}

// ---------------------------------------------------------------------------
// Date selection
// ---------------------------------------------------------------------------

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface DateResolutionResult {
  /** A date that IS in availableDates — safe to book. */
  matchedIso: string | null;
  /** Set when we understood a specific date the user asked for, but it
   *  isn't in availableDates — lets the orchestrator say exactly which
   *  date wasn't available instead of silently re-listing everything. */
  requestedIso?: string;
}

export function resolveDateSelection(userText: string, availableDates: string[]): DateResolutionResult {
  const lower = userText.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const toISO = (d: Date) => d.toISOString().slice(0, 10);

  // 1. Explicit calendar date — highest priority, always checked first.
  const explicitIso = parseCalendarDateMention(userText, today);
  if (explicitIso) {
    return availableDates.includes(explicitIso)
      ? { matchedIso: explicitIso }
      : { matchedIso: null, requestedIso: explicitIso };
  }

  if (/\btoday\b/.test(lower)) {
    const iso = toISO(today);
    return availableDates.includes(iso) ? { matchedIso: iso } : { matchedIso: null, requestedIso: iso };
  }
  if (/\btomorrow\b/.test(lower)) {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    const iso = toISO(t);
    return availableDates.includes(iso) ? { matchedIso: iso } : { matchedIso: null, requestedIso: iso };
  }

  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (lower.includes(WEEKDAYS[i]) || new RegExp(`\\b${WEEKDAY_ABBR[i]}\\b`).test(lower)) {
      const match = availableDates.find((iso) => new Date(iso + "T00:00:00").getDay() === i);
      if (match) return { matchedIso: match };
    }
  }

  // 2. Only spelled-out ordinal words ("the second one") mean list position.
  //    Digit-suffix forms ("5th") are reserved for calendar dates above.
  const idx = findWordOrdinalIndex(userText);
  if (idx !== null && availableDates[idx]) return { matchedIso: availableDates[idx] };

  // 3. Vague "whatever's free" style requests -> earliest offered date.
  if (SOON_RE.test(lower) && availableDates.length > 0) {
    return { matchedIso: [...availableDates].sort()[0] };
  }
  if (LATER_RE.test(lower) && availableDates.length > 0) {
    return { matchedIso: [...availableDates].sort().at(-1)! };
  }

  return { matchedIso: null };
}

// ---------------------------------------------------------------------------
// "Whatever's free" style requests — no specific date/time in mind, just
// wants the soonest option offered. Shared by date and time resolution.
// ---------------------------------------------------------------------------
const SOON_RE =
  /\b(earliest|earlier|sooner|soonest|asap|as soon as possible|next available|first available|whatever'?s?\s*(free|available|open)|any (time|slot|day)|no preference|doesn'?t matter|you (choose|pick|decide))\b/i;

// Mirror of SOON_RE for the opposite direction ("the later one", "whichever
// is last") — small local LLMs proved unreliable at this exact kind of
// relative comparison (see resolveAmbiguousChoice), so it's handled here
// deterministically instead of being left to the LLM fallback.
const LATER_RE = /\b(later|latest|last one|the last|whichever is later)\b/i;

// ---------------------------------------------------------------------------
// Time selection
// ---------------------------------------------------------------------------

export interface TimeResolutionResult {
  matchedSlot: SlotRecord | null;
  /** Set when we understood a specific time, but it's not offered that day. */
  requestedLabel?: string;
}

function to12Hour(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

// Bare/spoken hour handling ("9", "nine", "9 o'clock", "half past 9",
// "quarter to 9") — none of these carry am/pm, so we match purely by the
// 12-hour clock position against whatever slots are actually offered.
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUMBER_WORD_ALTERNATION = Object.keys(WORD_NUMBERS).join("|");

function wordOrDigitHour(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) {
    const n = parseInt(token, 10);
    return n >= 1 && n <= 12 ? n : null;
  }
  return WORD_NUMBERS[token] ?? null;
}

function slotHour12(slot: SlotRecord): number {
  const h = parseInt(slot.startTime.split(":")[0], 10) % 12;
  return h === 0 ? 12 : h;
}

function slotMinute(slot: SlotRecord): number {
  return parseInt(slot.startTime.split(":")[1], 10);
}

function matchSlotsByHour12(hour12: number, slots: SlotRecord[]): SlotRecord[] {
  return slots.filter((s) => slotHour12(s) === hour12);
}

/** Among same-hour candidates, prefer an exact minute match, then the
 *  top-of-the-hour slot (what a bare hour like "9" means in everyday
 *  speech), then the earliest of what's left. */
function pickAmongAmbiguous(candidates: SlotRecord[], minute: number | null): SlotRecord | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (minute !== null) {
    const exact = candidates.find((s) => slotMinute(s) === minute);
    if (exact) return exact;
  }
  const onHour = candidates.find((s) => slotMinute(s) === 0);
  if (onHour) return onHour;
  return [...candidates].sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
}
export async function searchDoctorsByName(nameQuery: string) {
  const q = nameQuery.replace(/^dr\.?\s+/i, "").trim();

  if (!q) return [];

  return db
    .select()
    .from(doctors)
    .where(
      and(
        eq(doctors.active, true),
        ilike(doctors.name, `%${q}%`)
      )
    )
    .limit(5);
}
/** Resolve which time slot the user meant: exact time match first, else ordinal position. */
export function resolveTimeSelection(userText: string, slots: SlotRecord[]): TimeResolutionResult {
  // Normalize "p.m." / "a.m." -> "pm" / "am" so both forms are recognized.
  const lower = userText.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();

  const timeMatch = lower.match(/\b(\d{1,2})(:(\d{2}))?\s?(am|pm)\b/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    const meridiem = timeMatch[4];
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    const target = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const match = slots.find((s) => s.startTime.startsWith(target));
    if (match) return { matchedSlot: match };
    return { matchedSlot: null, requestedLabel: to12Hour(hour, minute) };
  }

  // If a month is mentioned, this is very likely a date reference bleeding
  // into the time-selection stage (e.g. "book for July 5th") — don't guess
  // a slot position off a stray digit in that case (this was the exact bug
  // that picked slot #5 for "...on July 5th").
  if (containsMonthMention(lower)) {
    return { matchedSlot: null };
  }

  // "half past 9" / "half past nine" -> :30
  const halfMatch = lower.match(new RegExp(`\\bhalf\\s*(?:past|after)?\\s*(\\d{1,2}|${NUMBER_WORD_ALTERNATION})\\b`));
  if (halfMatch) {
    const hour12 = wordOrDigitHour(halfMatch[1]);
    if (hour12) {
      const picked = pickAmongAmbiguous(matchSlotsByHour12(hour12, slots), 30);
      if (picked) return { matchedSlot: picked };
      return { matchedSlot: null, requestedLabel: `${hour12}:30` };
    }
  }

  // "quarter past 9" -> :15
  const quarterPastMatch = lower.match(new RegExp(`\\bquarter\\s*(?:past|after)\\s*(\\d{1,2}|${NUMBER_WORD_ALTERNATION})\\b`));
  if (quarterPastMatch) {
    const hour12 = wordOrDigitHour(quarterPastMatch[1]);
    if (hour12) {
      const picked = pickAmongAmbiguous(matchSlotsByHour12(hour12, slots), 15);
      if (picked) return { matchedSlot: picked };
      return { matchedSlot: null, requestedLabel: `${hour12}:15` };
    }
  }

  // "quarter to 9" -> (9-1):45
  const quarterToMatch = lower.match(new RegExp(`\\bquarter\\s*to\\s*(\\d{1,2}|${NUMBER_WORD_ALTERNATION})\\b`));
  if (quarterToMatch) {
    const hour12 = wordOrDigitHour(quarterToMatch[1]);
    if (hour12) {
      const prevHour = hour12 === 1 ? 12 : hour12 - 1;
      const picked = pickAmongAmbiguous(matchSlotsByHour12(prevHour, slots), 45);
      if (picked) return { matchedSlot: picked };
      return { matchedSlot: null, requestedLabel: `${prevHour}:45` };
    }
  }

  // Bare hour, spoken or typed, with no minute/meridiem at all: "9", "nine",
  // "at 9", "9 o'clock". This is deliberately anchored to (almost) the whole
  // utterance so a stray digit elsewhere in a longer sentence can't misfire.
  // When more than one offered slot shares that hour (e.g. 9:00 and 9:30),
  // a bare "9" means the top of the hour — see pickAmongAmbiguous.
  const bareCandidate = lower.replace(/\bo'?\s*clock\b/g, "").trim();
  const bareMatch = bareCandidate.match(
    new RegExp(`^(?:at|around|about|maybe|let'?s say)?\\s*(\\d{1,2}|${NUMBER_WORD_ALTERNATION})\\s*$`)
  );
  if (bareMatch) {
    const hour12 = wordOrDigitHour(bareMatch[1]);
    if (hour12) {
      const picked = pickAmongAmbiguous(matchSlotsByHour12(hour12, slots), null);
      if (picked) return { matchedSlot: picked };
      return { matchedSlot: null, requestedLabel: `${hour12}:00` };
    }
  }

  // List position: "the second one" (word ordinals only — digit forms like
  // "5th" are reserved for calendar dates, see comment above).
  const idx = findWordOrdinalIndex(userText);
  if (idx !== null && slots[idx]) return { matchedSlot: slots[idx] };

  // Vague "whatever's free" style requests -> earliest offered slot.
  if (SOON_RE.test(lower) && slots.length > 0) {
    return { matchedSlot: [...slots].sort((a, b) => a.startTime.localeCompare(b.startTime))[0] };
  }
  if (LATER_RE.test(lower) && slots.length > 0) {
    return { matchedSlot: [...slots].sort((a, b) => a.startTime.localeCompare(b.startTime)).at(-1)! };
  }

  return { matchedSlot: null };
}

// ---------------------------------------------------------------------------
// Patient name / phone validation — never silently accept garbage input,
// which previously caused an entire sentence to be stored as a "phone
// number" and crash the DB insert (varchar(20) overflow).
// ---------------------------------------------------------------------------

const NAME_LEADING_FILLER_RE = /^(yes,?\s*)?(please,?\s*)?(um,?\s*)?(my name is|i am|i'm|it'?s|this is|name'?s|call me)\s*/i;
const NAME_TRAILING_FILLER_RE = /\s*\b(as i said before|again|please)\b\s*/gi;

/** Extract a plausible human name from free speech, or null if it doesn't look like one. */
export function extractValidName(text: string): string | null {
  let candidate = text
    .trim()
    .replace(NAME_LEADING_FILLER_RE, "")
    .replace(NAME_TRAILING_FILLER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/^[a-zA-Z][a-zA-Z .'-]{1,59}$/.test(candidate)) return candidate;
  return null;
}

/** Extract a plausible phone number (7-15 digits) from free speech, or null if it doesn't look like one. */
export function extractValidPhone(text: string): string | null {
  const digitsOnly = text.replace(/\D/g, "");
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return null;
  return digitsOnly;
}
