import { TurnFacts } from "./types";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const TIMEOUT_MS = parseInt(process.env.LLM_PHRASING_TIMEOUT_MS || "15000", 10);

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

function buildUserPrompt(facts: TurnFacts): string {
  return `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nRespond as Maya, speaking this turn's outcome naturally in 1-3 short sentences.`;
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
    case "ask_doctor_choice":
      return "Which doctor would you like to book with?";
    case "list_dates":
      return `Dr. ${d.doctorName} is available on: ${d.dates.join(", ")}. Which date works for you?`;
    case "ask_date_choice":
      return "Which date would you like?";
    case "list_slots":
      return `On ${d.date}, available times are: ${d.times.join(", ")}. Which time suits you?`;
    case "ask_time_choice":
      return "Which time slot would you like?";
    case "ask_name":
      return d?.retry
        ? "Sorry, I didn't catch a valid name there — could you tell me your full name?"
        : "Great. Can I have your full name for the booking?";
    case "ask_phone":
      return d?.retry
        ? "That doesn't look like a valid phone number — could you say it again, digits only?"
        : "Thanks. And what's the best phone number to reach you?";
    case "date_unavailable":
      return `Sorry, ${d.requestedDate} isn't available. Open dates are: ${d.dates.join(", ")}. Which of these works for you?`;
    case "time_unavailable":
      return `Sorry, ${d.requestedTime} isn't open on that day. Available times are: ${d.times.join(", ")}. Which one works?`;
    case "ask_change_target":
      return "No problem — would you like to change the date, the time, or the doctor?";
    case "confirm_booking_details":
      return `Just to confirm: an appointment with Dr. ${d.doctorName} on ${d.date} at ${d.time} for ${d.patientName}. Shall I go ahead and book it?`;
    case "booking_success":
      return `You're all set! Your appointment with Dr. ${d.doctorName} on ${d.date} at ${d.time} is confirmed.`;
    case "booking_failed":
      return "I'm sorry, that slot was just taken by someone else. Would you like to pick another time?";
    case "list_appointments": {
      const list = (d.appointments as any[])
        .map((a) => `Dr. ${a.doctorName} on ${a.date} at ${a.time}`)
        .join("; ");
      return `Here's what you have booked: ${list}.`;
    }
    case "confirm_reschedule":
      return `You have an appointment with Dr. ${d.doctorName} on ${d.date} at ${d.time}. Would you like me to cancel this one so we can book a new time?`;
    case "reschedule_select_date":
      return `Alright, that's cancelled. Dr. ${d.doctorName} is available on: ${d.dates.join(", ")}. Which date would you like for the new appointment?`;
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
      return `Just to confirm, cancel your appointment with Dr. ${d.doctorName} on ${d.date} at ${d.time}?`;
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
]);

// Extra safety net for the remaining (lower-stakes, more conversational)
// actions that still go through Ollama: if the model invents anything
// about phone calls or callbacks — which it has no business mentioning,
// since it never has that in FACTS — treat the whole response as
// unreliable and fall back to the template instead of speaking it.
const HALLUCINATION_RED_FLAGS = /\b(give (you |me )?a call|call (you |me )?back|call now|phone call|call me later)\b/i;

export async function phraseResponse(facts: TurnFacts): Promise<string> {
  if (DETERMINISTIC_ONLY_ACTIONS.has(facts.action)) {
    console.log(`[LLM] action="${facts.action}" is deterministic-only — skipping Ollama for accuracy + latency`);
    return templateFallback(facts);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
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

    console.log("[LLM] phrased via Ollama:", text);
    return text;
  } catch (err) {
    clearTimeout(timeout);
    console.warn("[LLM] Ollama unavailable/slow/unreliable, using deterministic template fallback:", (err as Error).message);
    return templateFallback(facts);
  }
}
