export type ConversationStage =
  | "greeting"
  | "awaiting_symptom_or_request"
  | "showing_doctors"
  | "awaiting_doctor_selection"
  | "showing_dates"
  | "awaiting_date_selection"
  | "showing_slots"
  | "awaiting_time_selection"
  | "awaiting_patient_name"
  | "awaiting_patient_phone"
  | "awaiting_confirmation"
  | "awaiting_change_target"
  | "booked"
  | "checking_appointments"
  | "cancelling_select_appointment"
  | "cancelling_confirm"
  | "done";

export type Intent =
  | "greeting"
  | "symptom_or_specialization_query"
  | "doctor_selection"
  | "date_selection"
  | "time_selection"
  | "confirm_yes"
  | "confirm_no"
  | "check_appointments"
  | "cancel_appointment"
  | "provide_name"
  | "provide_phone"
  | "goodbye"
  | "unknown";

export interface DoctorRecord {
  id: number;
  name: string;
  specialization: string;
  qualifications: string | null;
  yearsExperience: number | null;
  clinicName: string | null;
  city: string | null;
  rating: number | null;
}

export interface SlotRecord {
  id: number;
  slotDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string;
  isBooked: boolean;
}

export interface DoctorSlotsByDate {
  doctorId: number;
  doctorName: string;
  slotsByDate: Record<string, SlotRecord[]>; // date -> available slots
  generatedAt: string;
}

export interface ConversationSession {
  sessionId: string;
  stage: ConversationStage;
  createdAt: string;
  updatedAt: string;

  // accumulated deterministic state — the "form" being filled in
  symptomText?: string;
  specialization?: string;
  candidateDoctors?: DoctorRecord[];
  selectedDoctorId?: number;
  selectedDoctorName?: string;
  availableDates?: string[]; // derived from cached slot map
  selectedDate?: string;
  availableSlotsForDate?: SlotRecord[];
  selectedSlotId?: number;
  selectedSlotTime?: string;
  patientName?: string;
  patientPhone?: string;
  reasonForVisit?: string;
  lastAppointments?: Array<{
    appointmentId: number;
    doctorName: string;
    date: string;
    time: string;
    status: string;
  }>;
}

/**
 * Facts are the ONLY thing the LLM ever sees for a given turn. They are
 * fully computed by deterministic code before the LLM is invoked. The LLM's
 * job is strictly: turn `facts` into one short, natural, spoken sentence (or
 * two). It must not add facts, doctors, dates, or times that are not present
 * here.
 */
export interface TurnFacts {
  intent: Intent;
  stage: ConversationStage;
  nextStage: ConversationStage;
  action:
    | "ask_symptom"
    | "list_doctors"
    | "ask_doctor_choice"
    | "list_dates"
    | "ask_date_choice"
    | "list_slots"
    | "ask_time_choice"
    | "date_unavailable"
    | "time_unavailable"
    | "ask_change_target"
    | "ask_name"
    | "ask_phone"
    | "confirm_booking_details"
    | "booking_success"
    | "booking_failed"
    | "list_appointments"
    | "no_appointments"
    | "ask_which_to_cancel"
    | "confirm_cancellation"
    | "cancellation_success"
    | "clarify_unknown"
    | "goodbye";
  data: Record<string, unknown>;
}
