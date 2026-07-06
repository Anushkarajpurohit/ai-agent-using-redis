import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  date,
  time,
  boolean,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "booked",
  "cancelled",
  "completed",
  "no_show",
]);

// ---------------------------------------------------------------------------
// Doctors
// ---------------------------------------------------------------------------
export const doctors = pgTable("doctors", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  // Kept as a normalized, lower-case, single-word-ish key so the deterministic
  // specialization map can do exact / keyword matching without LLM help.
  specialization: varchar("specialization", { length: 80 }).notNull(),
  qualifications: text("qualifications"),
  yearsExperience: integer("years_experience").default(0),
  clinicName: varchar("clinic_name", { length: 150 }),
  city: varchar("city", { length: 80 }),
  rating: integer("rating").default(0), // stored as x10 (e.g. 47 = 4.7) to avoid float issues
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Slot templates -> materialized slots
// A doctor has a recurring weekly template, but we also keep concrete
// per-date slot rows so we can mark individual slots booked/unavailable.
// ---------------------------------------------------------------------------
export const doctorSlots = pgTable("doctor_slots", {
  id: serial("id").primaryKey(),
  doctorId: integer("doctor_id")
    .references(() => doctors.id)
    .notNull(),
  slotDate: date("slot_date").notNull(), // e.g. 2026-07-06
  startTime: time("start_time").notNull(), // e.g. 09:30:00
  endTime: time("end_time").notNull(),
  isBooked: boolean("is_booked").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Patients (minimal - voice agent captures name + phone, no auth in MVP)
// ---------------------------------------------------------------------------
export const patients = pgTable("patients", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  phone: varchar("phone", { length: 20 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id")
    .references(() => patients.id)
    .notNull(),
  doctorId: integer("doctor_id")
    .references(() => doctors.id)
    .notNull(),
  slotId: integer("slot_id")
    .references(() => doctorSlots.id)
    .notNull(),
  status: appointmentStatusEnum("status").default("booked").notNull(),
  reasonForVisit: text("reason_for_visit"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  cancelledAt: timestamp("cancelled_at"),
});
