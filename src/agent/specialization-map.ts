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
    "dermatologist", "dermatology", "skin doctor",
  ],
  cardiology: [
    "chest pain", "heart", "palpitation", "palpitations", "blood pressure",
    "hypertension", "cholesterol",
    "cardiologist", "cardiology", "heart doctor",
  ],
  orthopedics: [
    "joint", "knee", "back pain", "fracture", "bone", "shoulder pain",
    "sprain", "arthritis", "spine",
    "orthopedist", "orthopedic", "orthopedics", "ortho", "bone doctor",
  ],
  pediatrics: [
    "baby", "infant", "toddler", "child fever", "kid", "newborn",
    "pediatrician", "paediatrician", "pediatrics", "paediatrics", "child specialist",
  ],
  ent: [
    "ear", "nose", "throat", "sinus", "hearing", "tonsil", "sore throat",
    "ent", "ent specialist", "ent doctor", "ear nose throat",
  ],
  gynecology: [
    "pregnancy", "pregnant", "menstrual", "period pain", "pcos", "gynec",
    "gynecologist", "gynaecologist", "gynecology", "gynaecology",
  ],
  neurology: [
    "migraine", "headache", "seizure", "numbness", "dizziness", "tremor",
    "neurologist", "neurology",
  ],
  psychiatry: [
    "anxiety", "depression", "stress", "panic attack", "insomnia", "sleep issue",
    "psychiatrist", "psychiatry", "therapist", "counselor", "counsellor",
  ],
  dentistry: [
    "tooth", "teeth", "cavity", "gum", "dental",
    "dentist", "dentistry",
  ],
  ophthalmology: [
    "eye", "vision", "blurry vision", "eyesight",
    "ophthalmologist", "ophthalmology", "eye doctor", "eye specialist",
  ],
  gastroenterology: [
    "stomach", "abdominal pain", "acidity", "diarrhea", "constipation",
    "nausea", "vomiting",
    "gastroenterologist", "gastroenterology", "stomach doctor",
  ],
  "general medicine": [
    "fever", "cold", "cough", "flu", "checkup", "fatigue",
    "general physician", "general medicine", "family doctor", "gp",
  ],
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
      // Word-boundary match, not a plain substring check — short keywords
      // like "ear" or "gum" otherwise false-positive inside unrelated words
      // ("earliest", "argument"), silently misrouting the specialty.
      if (new RegExp(`\\b${kw}\\b`).test(text)) {
        return { specialization, matchedKeyword: kw, confident: true };
      }
    }
  }

  // Deterministic fallback — never guessed by the LLM.
  return { specialization: "general medicine", matchedKeyword: null, confident: false };
}

export const ALL_SPECIALIZATIONS = Object.keys(SYMPTOM_KEYWORDS) as Specialization[];
