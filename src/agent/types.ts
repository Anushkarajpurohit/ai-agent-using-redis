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
  | "awaiting_time_preference"
  | "checking_appointments"
  | "cancelling_select_appointment"
  | "cancelling_confirm"
  | "rescheduling_lookup"
  | "done";

export type ConversationGoal =
  | "none"
  | "booking"
  | "cancellation"
  | "reschedule"
  | "lookup";

export interface CollectedSlots {
  symptomText?: string;
  specialization?: string;
  doctorId?: number;
  doctorName?: string;
  date?: string;
  slotId?: number;
  slotTime?: string;
  patientName?: string;
  patientPhone?: string;
  patientId?: number;
}

export type Intent =
  | "new_booking_request"
  | "greeting"
  | "symptom_or_specialization_query"
  | "reschedule_appointment"
  | "doctor_selection"
  | "date_selection"
  | "time_selection"
  | "confirm_yes"
  | "confirm_no"
  | "time_preference"
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
  goal: ConversationGoal;
  stage: ConversationStage;
  createdAt: string;
  updatedAt: string;

  contextStack?: Array<{
    stage: ConversationStage;
    data: Partial<ConversationSession>;
  }>;
  previousContext?: Partial<ConversationSession>;
  phonePurpose?: "booking" | "lookup" | "cancel" | "reschedule";
  rescheduleContext?: {
    doctorId: number;
    doctorName: string;
    patientPhone: string;
  };

  sessionPhone?: string;
  sessionPatientId?: number;
  sessionPatientName?: string;
  appointmentToCancelId?: number;
  existingPatientId?: number;
  // accumulated deterministic state — the "form" being filled in
  symptomText?: string;
  specialization?: string;
  candidateDoctors?: DoctorRecord[];
  selectedDoctorId?: number;
  selectedDoctorName?: string;
  availableDates?: string[]; // derived from cached slot map
  selectedDate?: string;
  allSlotsForDate?: SlotRecord[];          // ← NEW: unfiltered full list
  availableSlotsForDate?: SlotRecord[];
  selectedSlotId?: number;
  selectedSlotTime?: string;
  patientName?: string;
  patientPhone?: string;

  reasonForVisit?: string;
  lastAppointments?: Array<{
    appointmentId: number;
    doctorName: string;
    doctorId?: number;
    date: string;
    time: string;
    status: string;
    // ADD THIS - needed for reschedule context

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
  | "no_appointments_retry"
  | "ask_time_preference"         // ← NEW
  | "no_slots_in_period"       // ADD
  | "ask_which_to_reschedule"    // ADD

  | "ask_which_to_cancel"
  | "confirm_cancellation"
  | "confirm_reschedule"         // ADD
  | "reschedule_select_date"     // ADD

  | "cancellation_success"
  | "clarify_unknown"
  | "workflow_switched"
  | "goodbye";
  data: Record<string, unknown>;
}
