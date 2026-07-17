import { TurnFacts } from "./types";

// const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
// const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
// const TIMEOUT_MS = parseInt(process.env.LLM_PHRASING_TIMEOUT_MS || "15000", 10);
// Ollama unloads idle models (default keep_alive ~5min), so the first call
// after a quiet stretch pays a cold-start cost (~4s locally) on top of
// inference. 6s covers that while still failing fast into the existing
// "ask again" behavior if Ollama is genuinely down.

const _GROQ_BASE_URL = process.env.GROQ_BASE_URL;
const _GROQ_MODEL = process.env.GROQ_MODEL;
const _GROQ_API_KEY = process.env.GROQ_API_KEY;
const CHOICE_TIMEOUT_MS = parseInt(process.env.LLM_CHOICE_TIMEOUT_MS || "6000", 10);

/**
 * Last-resort disambiguation: only called after ALL deterministic matchers
 * (name/date/time parsing, ordinals, "earliest available", etc.) have
 * already failed to make sense of the utterance. It is handed the exact
 * list of real options already fetched from the DB/session and MUST pick
 * one of them verbatim or say none — it can never introduce a doctor,
 * date, or time that wasn't already on offer, so it carries no more
 * hallucination risk than the deterministic matchers it's backing up.
 *
 * Kept on a short timeout and a tiny local model call (temperature 0,
 * ~5 tokens of output) so it only adds latency on the rare turn where
 * regex matching already failed — the golden path never touches this.
 */

function buildUserPrompt(facts: TurnFacts): string {
  return `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nRespond as Maya, speaking this turn's outcome naturally in 1-3 short sentences.`;
}
export async function resolveAmbiguousChoice(
  facts: TurnFacts | undefined,
  userText: string,
  kind: "doctor" | "date" | "time",
  options: { label: string; value: string }[]
): Promise<string | null>;
export async function resolveAmbiguousChoice(
  userText: string,
  kind: "doctor" | "date" | "time",
  options: { label: string; value: string }[]
): Promise<string | null>;
export async function resolveAmbiguousChoice(
  factsOrUserText: TurnFacts | undefined | string,
  userTextOrKind: string,
  kindOrOptions: "doctor" | "date" | "time" | { label: string; value: string }[],
  options?: { label: string; value: string }[]
): Promise<string | null> {
  let facts: TurnFacts | undefined;
  let userText: string;
  let kind: "doctor" | "date" | "time";
  let resolvedOptions: { label: string; value: string }[];

  if (options !== undefined) {
    // 4-arg form: resolveAmbiguousChoice(facts, userText, kind, options)
    facts = factsOrUserText as TurnFacts | undefined;
    userText = userTextOrKind;
    kind = kindOrOptions as "doctor" | "date" | "time";
    resolvedOptions = options;
  } else {
    // 3-arg form: resolveAmbiguousChoice(userText, kind, options)
    facts = undefined;
    userText = factsOrUserText as string;
    kind = userTextOrKind as "doctor" | "date" | "time";
    resolvedOptions = kindOrOptions as { label: string; value: string }[];
  }

  if (resolvedOptions.length === 0) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHOICE_TIMEOUT_MS);

  try {
    const userPrompt = facts
      ? buildUserPrompt(facts)
      : `User said: "${userText}". Choose the best matching ${kind} from the list.`;

    const res = await fetch(`${_GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_GROQ_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: _GROQ_MODEL,
        temperature: 0.4,
        max_tokens: 120,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    clearTimeout(timeout);
    // try {
    //   const list = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
    //   const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json" },
    //     signal: controller.signal,
    //     body: JSON.stringify({
    //       model: OLLAMA_MODEL,
    //       temperature: 0,
    //       max_tokens: 5,
    //       messages: [
    //         {
    //           role: "system",
    //           content:
    //             'You match a caller\'s spoken phrase to one option from a numbered list. Reply with ONLY the number of the matching option, or the word "none" if nothing matches. Never explain, never invent an option that is not listed.',
    //         },
    //         {
    //           role: "user",
    //           content: `Caller said: "${userText}"\n\nThey are choosing a ${kind} from:\n${list}\n\nWhich number?`,
    //         },
    //       ],
    //     }),
    //   });
    //   clearTimeout(timeout);

    if (!res.ok) return null;
    const json = await res.json();
    console.log(`Error: ${_GROQ_BASE_URL}`);

    const text: string = json?.choices?.[0]?.message?.content?.trim() ?? "";
    const num = parseInt(text.match(/\d+/)?.[0] ?? "", 10);
    if (!Number.isNaN(num) && resolvedOptions[num - 1]) {
      console.log(`[LLM] resolved ambiguous ${kind} choice "${userText}" -> "${resolvedOptions[num - 1].label}"`);
      return resolvedOptions[num - 1].value;
    }
    return null;
  } catch (err) {
    console.log(`Error: ${_GROQ_BASE_URL}`);

    clearTimeout(timeout);
    console.warn(`[LLM] ambiguous ${kind} choice resolution failed/timed out:`, (err as Error).message);
    return null;
  }
}


// const _GROQ_BASE_URL = process.env.GROQ_BASE_URL;
// const _GROQ_MODEL = process.env.GROQ_MODEL;
// const _GROQ_API_KEY = process.env.GROQ_API_KEY;


/**
 * System prompt is deliberately locked down: the model receives ONLY the
 * `facts` JSON for this turn and is told, explicitly, that it may not
 * introduce any name, date, time, or number that isn't already present in
 * that JSON. This is what keeps hallucination out of a medical-booking
 * context — the LLM is a phrasing layer, not a source of truth.
 */
const SYSTEM_PROMPT = `You are Maya, a warm, efficient, professional medical clinic receptionist speaking out loud to a patient on a voice call. This IS the phone call — the patient is already talking to you live. Never ask them to call, call back, or suggest a phone call; you are not scheduling a call, you already are one.

STRICT RULES:
- You will be given a JSON object called FACTS. It contains everything true about this turn of the conversation.
- You must speak ONLY using information present in FACTS. Never invent a doctor name, date, time, price, symptom, or medical advice that is not explicitly in FACTS.
- Never mention phone calls, calling back, or "giving a call" — the only reason to mention a phone number is to record it for the booking, never to arrange contact.
- Never give medical advice or diagnosis. You only help book/find/cancel appointments.
- Keep responses short: 1-3 sentences, natural spoken language, no markdown, no bullet lists, no asterisks — this will be read aloud by a TTS engine.
- If FACTS.action lists options (doctors, dates, times), read them out naturally and end with a clear question about what to pick.
- Do not repeat the entire FACTS object back verbatim — phrase it conversationally.
- If FACTS contains an error or "no results", say so plainly and helpfully, and suggest a next step, without apologizing excessively.`;

// Doctor names stored in the DB already include a "Dr." prefix (e.g. "Dr.
// Priya Mehta"), so templates that prepend their own "Dr. " were rendering
// "Dr. Dr. Priya Mehta" — normalize once here instead of at each call site.
function withDr(name: string | undefined): string {
  if (!name) return "";
  return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}



/**
 * Deterministic, template-based fallback phrasing. Used if Ollama is
 * unreachable or too slow — this guarantees the agent NEVER blocks a
 * booking flow on LLM availability, and never hallucinates because these
 * templates only interpolate values straight from `facts`.
 */
function templateFallback(facts: TurnFacts): string {
  const d = facts.data as any;
  switch (facts.action) {
    case "ask_symptom":
      return "Hi, I'm Maya. Could you tell me what symptoms you're having, or which kind of doctor you'd like to see?";
    case "list_doctors": {
      const names = (d.doctors as any[]).map((doc, i) => `${i + 1}. ${doc.name}`).join(", ");
      return `For ${d.specialization}, I found: ${names}. Who would you like to book with?`;
    }
    case "ask_time_preference": {
      const parts: string[] = [];
      if (d.morningCount > 0)
        parts.push(
          `morning (${d.morningCount} slot${d.morningCount > 1 ? "s" : ""})`
        );
      if (d.afternoonCount > 0)
        parts.push(
          `afternoon (${d.afternoonCount} slot${d.afternoonCount > 1 ? "s" : ""})`
        );
      if (d.eveningCount > 0)
        parts.push(
          `evening (${d.eveningCount} slot${d.eveningCount > 1 ? "s" : ""})`
        );
      const prefix = d?.doctorName ? `You're booking with ${withDr(d.doctorName)}. ` : "";
      return d?.retry
        ? `${prefix}I didn't catch that. We have ${parts.join(", ")} on ${d.date}. Would you prefer morning, afternoon, or evening?`
        : `${prefix}For ${d.date}, we have ${parts.join(", ")}. Would you prefer morning, afternoon, or evening?`;
    }
    // In your action switch statement, add:

    case "ask_symptom": {
      if (facts.data.resumeAvailable) {
        return "Ask if they want to continue their previous booking or start a new one.";
      } else {
        return "Greet warmly and ask what brings them in today or which doctor they'd like to see.";
      }
    }
    case "clarify_unknown": {
      if (d.reason === "doctor_not_found") {
        return `I couldn't find a ${withDr(d.doctorName)} in our system. Could you double-check the name, or tell me your symptoms so I can find the right doctor for you?`;
      }
      if (d.reason === "no_availability") {
        return `${withDr(d.doctorName)} doesn't have any open slots this week. Would you like to try another doctor?`;
      }
      if (d.reason === "no_doctors_for_specialization") {
        return d.confident
          ? `I don't see any doctors available for ${d.specialization} right now. Would you like to try a different concern, or see a general physician instead?`
          : "Could you tell me a bit more about your symptoms — like skin issues, chest pain, or joint pain — so I can find the right doctor for you?";
      }
      return "Sorry, I didn't quite catch that — could you rephrase?";
    }
    case "list_slots":
      if (d.period) {
        return `Here are the ${d.period} slots on ${d.date}: ${(d.times as string[]).join(", ")}. Which time works for you?`;
      }
      return `On ${d.date}, available times are: ${(d.times as string[]).join(", ")}. Which time suits you?`;
    case "no_slots_in_period":
      return `Sorry, there are no ${d.period} slots on ${d.date}. We have openings in the ${(d.periods as string[]).join(" and ")}. Which would you prefer?`;
    case "ask_doctor_choice":
      return "Which doctor would you like to book with?";
    case "list_dates":
      return `${withDr(d.doctorName)} is available on: ${d.dates.join(", ")}. Which date works for you?`;
    case "ask_date_choice":
      return d?.doctorName
        ? `You're booking with ${withDr(d.doctorName)}. Which date would you like?`
        : "Which date would you like?";
    case "list_slots":
      return `On ${d.date}, available times are: ${d.times.join(", ")}. Which time suits you?`;
    case "ask_time_choice":
      return d?.doctorName
        ? `For ${withDr(d.doctorName)}, which time slot would you like?`
        : "Which time slot would you like?";
    case "ask_name":
      return d?.retry
        ? "Sorry, I didn't catch a valid name there — could you tell me your full name?"
        : "Great. Can I have your full name for the booking?";
    case "ask_phone":
      if (d?.retry) {
        if (d?.purpose === "reschedule")
          return "I need your phone number to look up your appointments. Could you say your 10-digit number again?";
        if (d?.purpose === "cancel")
          return "I need your phone number to find the appointment. Could you say your 10-digit number?";
        return "That doesn't look like a valid phone number — could you say it again, digits only?";
      }
      if (d?.purpose === "reschedule")
        return "Sure, I can help you reschedule. What's the phone number the appointment was booked under?";
      if (d?.purpose === "cancel")
        return "I can help you cancel that. What's the phone number the appointment was booked under?";
      if (d?.purpose === "lookup")
        return "I'll look that up for you. What phone number are your appointments under?";
      if (d?.purpose === "booking")
        return "Could I have your phone number? If you've been here before, I'll pull up your details automatically.";
      return "Could I have your phone number please?";
    case "date_unavailable":
      return `Sorry, ${d.requestedDate} isn't available. Open dates are: ${d.dates.join(", ")}. Which of these works for you?`;
    case "time_unavailable":
      return `Sorry, ${d.requestedTime} isn't open on that day. Available times are: ${d.times.join(", ")}. Which one works?`;
    case "ask_change_target":
      return "No problem — would you like to change the date, the time, or the doctor?";
    case "confirm_booking_details":
      return `Just to confirm: an appointment with ${withDr(d.doctorName)} on ${d.date} at ${d.time} for ${d.patientName}. Shall I go ahead and book it?`;
    case "booking_success":
      return `You're all set! Your appointment with ${withDr(d.doctorName)} on ${d.date} at ${d.time} is confirmed.`;
    case "booking_failed":
      return "I'm sorry, that slot was just taken by someone else. Would you like to pick another time?";
    case "list_appointments": {
      const list = (d.appointments as any[])
        .map((a) => `${withDr(a.doctorName)} on ${a.date} at ${a.time}`)
        .join("; ");
      return `Here's what you have booked: ${list}.`;
    }
    case "confirm_reschedule":
      return `You have an appointment with ${withDr(d.doctorName)} on ${d.date} at ${d.time}. Would you like me to cancel this one so we can book a new time?`;
    case "reschedule_select_date":
      return `Alright, that's cancelled. ${withDr(d.doctorName)} is available on: ${d.dates.join(", ")}. Which date would you like for the new appointment?`;
    case "ask_which_to_reschedule":
      return `You have ${(d.appointments as any[]).length} upcoming appointments. Which one would you like to reschedule?`;
    case "no_appointments_retry":
      return d?.context === "reschedule"
        ? "I don't see any upcoming appointments under that number. Could you double-check the phone number?"
        : "I don't see any upcoming appointments under that number. Would you like to try a different number?";
    case "no_appointments":
      return "I don't see any upcoming appointments under that number.";
    case "ask_which_to_cancel":
      return "Which appointment would you like to cancel?";
    case "confirm_cancellation":
      return `Just to confirm, cancel your appointment with ${withDr(d.doctorName)} on ${d.date} at ${d.time}?`;
    case "cancellation_success":
      return d?.offerRebook
        ? "Done — that appointment has been cancelled. Would you like to book a new appointment now?"
        : "Done — that appointment has been cancelled.";
    case "clarify_unknown": {
      if (d.reason === "no_doctors_for_specialization") {
        return d.confident
          ? `I don't see any doctors available for ${d.specialization} right now. Would you like to try a different concern, or see a general physician instead?`
          : "Could you tell me a bit more about your symptoms — like skin issues, chest pain, or joint pain — so I can find the right doctor for you?";
      }
      return "Sorry, I didn't quite catch that — could you rephrase?";
    }
    case "workflow_switched":
      return "Sure, let me help you with that instead.";
    case "goodbye":
      return "Thanks for calling, take care!";
    default:
      return "Okay.";
  }
}

// These turns must be exactly correct — a name, a phone number, a booking
// confirmation, a cancellation, a read-back of real appointments. Handing
// these to a small local model (phi3:mini) was producing fabricated content
// ("I asked you to call back on the 25th or 27th", "would you like to give
// me a call?") that has nothing to do with the actual facts. For these
// actions we skip the LLM entirely: it's both more accurate AND faster,
// since these are also the most frequently-hit turns in any conversation.
const DETERMINISTIC_ONLY_ACTIONS = new Set<TurnFacts["action"]>([
  "ask_phone",
  "ask_name",
  "confirm_booking_details",
  "booking_success",
  "confirm_cancellation",
  "cancellation_success",
  "list_appointments",
  "no_appointments",
  "no_appointments_retry",           // ← ADD
  "date_unavailable",
  "time_unavailable",
  "confirm_reschedule",
  "reschedule_select_date",
  "ask_which_to_reschedule",
  "ask_which_to_cancel",
  "list_slots",                // ← ADD (prevents LLM truncating 10 slots to 2)
  "ask_time_preference",       // ← ADD
  "no_slots_in_period",
  "workflow_switched",
  "ask_date_choice",
  "ask_time_choice",
  // Any turn that names, lists, or asks about doctors was going through
  // Ollama and had no guard against inventing names — a 3B local model
  // fabricated two entirely fictitious doctors ("Dr. Emily Chen", "Dr.
  // Kevin Lee") with fake availability when asked a vague follow-up
  // ("nerve doctor") that didn't match any real specialization keyword.
  // These all have accurate, existing templates below — use them.
  "clarify_unknown",
  "list_doctors",
  "ask_doctor_choice",
  "list_dates",
]);

// Extra safety net for the remaining (lower-stakes, more conversational)
// actions that still go through Ollama: if the model invents anything
// about phone calls or callbacks — which it has no business mentioning,
// since it never has that in FACTS — treat the whole response as
// unreliable and fall back to the template instead of speaking it.
const HALLUCINATION_RED_FLAGS = /\b(give (you |me )?a call|call (you |me )?back|call now|phone call|call me later)\b/i;

// Defense-in-depth against the failure mode that actually happened in
// practice: given a vague FACTS payload (e.g. clarify_unknown with no real
// doctor data at all), the model fabricated two entirely fictitious doctors
// with fake availability instead of admitting it didn't have that info.
// Every doctor name that could legitimately appear in a phrased response is
// already present in FACTS somewhere — collect those, and if the model's
// text mentions a "Dr. <name>" that isn't one of them, treat it exactly
// like any other hallucination and fall back to the safe template.
const DOCTOR_MENTION_RE = /\bdr\.?\s+([a-z]+(?:\s+[a-z]+){0,2})/gi;

function collectAllowedDoctorNames(facts: TurnFacts): string[] {
  const d = facts.data as any;
  const names: string[] = [];
  if (typeof d?.doctorName === "string") names.push(d.doctorName);
  if (Array.isArray(d?.doctors)) {
    for (const doc of d.doctors) if (typeof doc?.name === "string") names.push(doc.name);
  }
  if (Array.isArray(d?.appointments)) {
    for (const a of d.appointments) if (typeof a?.doctorName === "string") names.push(a.doctorName);
  }
  return names.map((n) => n.toLowerCase().replace(/^dr\.?\s*/i, "").trim()).filter(Boolean);
}

function mentionsUnknownDoctor(text: string, allowedNames: string[]): boolean {
  for (const match of text.matchAll(DOCTOR_MENTION_RE)) {
    const mentioned = match[1].toLowerCase().trim();
    const isKnown = allowedNames.some((n) => n.includes(mentioned) || mentioned.includes(n));
    if (!isKnown) return true;
  }
  return false;
}

export async function phraseResponse(facts: TurnFacts): Promise<string> {
  if (DETERMINISTIC_ONLY_ACTIONS.has(facts.action)) {
    console.log(`[LLM] action="${facts.action}" is deterministic-only — skipping Ollama for accuracy + latency`);
    return templateFallback(facts);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHOICE_TIMEOUT_MS);


  // try {
  //   const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     signal: controller.signal,
  //     body: JSON.stringify({
  //       model: OLLAMA_MODEL,
  //       temperature: 0.4,
  //       max_tokens: 120,
  //       messages: [
  //         { role: "system", content: SYSTEM_PROMPT },
  //         { role: "user", content: buildUserPrompt(facts) },
  //       ],
  //     }),
  //   });
  //   clearTimeout(timeout);
  try {
    const res = await fetch(`${_GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_GROQ_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: _GROQ_MODEL,
        temperature: 0.4,
        max_tokens: 120,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(facts) },
        ],
      }),
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
    const json = await res.json();
    const text: string | undefined = json?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty LLM response");
    if (HALLUCINATION_RED_FLAGS.test(text)) {
      throw new Error(`Suspected hallucination (mentions calling/phone contact): "${text}"`);
    }
    // console.log(`Error: ${_GROQ_BASE_URL}`);

    console.log("[LLM] phrased via Ollama:", text);
    return text;
  } catch (err) {
    clearTimeout(timeout);
    // console.log(`Error: ${_GROQ_BASE_URL}`);

    console.warn("[LLM] Ollama unavailable/slow/unreliable, using deterministic template fallback:", (err as Error).message);
    return templateFallback(facts);
  }
}
