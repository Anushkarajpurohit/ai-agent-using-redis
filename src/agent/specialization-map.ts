/**
 * Deterministic symptom -> specialization mapping.
 *
 * This is intentionally a plain keyword table, NOT an LLM call. The LLM is
 * never trusted to decide "which doctor type do you need" — that's a
 * business/medical-routing decision, and it must be reproducible, auditable,
 * and instant. If a symptom isn't recognized, we fall back to
 * "general medicine" and let the receptionist ask a clarifying question.
 */

export type Specialization =
  | "general medicine"
  | "dermatology"
  | "cardiology"
  | "orthopedics"
  | "pediatrics"
  | "ent"
  | "gynecology"
  | "neurology"
  | "psychiatry"
  | "dentistry"
  | "ophthalmology"
  | "gastroenterology";

// Order matters only in that first match wins per keyword group; keep groups
// mutually distinct as far as possible.
const SYMPTOM_KEYWORDS: Record<Specialization, string[]> = {
  dermatology: [
    "rash", "rashes", "skin", "acne", "itch", "itching", "eczema",
    "psoriasis", "mole", "hives", "dandruff",
  ],
  cardiology: [
    "chest pain", "heart", "palpitation", "palpitations", "blood pressure",
    "hypertension", "cholesterol",
  ],
  orthopedics: [
    "joint", "knee", "back pain", "fracture", "bone", "shoulder pain",
    "sprain", "arthritis", "spine",
  ],
  pediatrics: [
    "baby", "infant", "toddler", "child fever", "kid", "newborn",
  ],
  ent: [
    "ear", "nose", "throat", "sinus", "hearing", "tonsil", "sore throat",
  ],
  gynecology: [
    "pregnancy", "pregnant", "menstrual", "period pain", "pcos", "gynec",
  ],
  neurology: [
    "migraine", "headache", "seizure", "numbness", "dizziness", "tremor",
  ],
  psychiatry: [
    "anxiety", "depression", "stress", "panic attack", "insomnia", "sleep issue",
  ],
  dentistry: [
    "tooth", "teeth", "cavity", "gum", "dental",
  ],
  ophthalmology: [
    "eye", "vision", "blurry vision", "eyesight",
  ],
  gastroenterology: [
    "stomach", "abdominal pain", "acidity", "diarrhea", "constipation",
    "nausea", "vomiting",
  ],
  "general medicine": ["fever", "cold", "cough", "flu", "checkup", "fatigue"],
};

export function resolveSpecialization(userText: string): {
  specialization: Specialization;
  matchedKeyword: string | null;
  confident: boolean;
} {
  const text = userText.toLowerCase();

  for (const [specialization, keywords] of Object.entries(SYMPTOM_KEYWORDS) as [
    Specialization,
    string[]
  ][]) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        return { specialization, matchedKeyword: kw, confident: true };
      }
    }
  }

  // Deterministic fallback — never guessed by the LLM.
  return { specialization: "general medicine", matchedKeyword: null, confident: false };
}

export const ALL_SPECIALIZATIONS = Object.keys(SYMPTOM_KEYWORDS) as Specialization[];
