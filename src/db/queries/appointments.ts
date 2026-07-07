import { and, eq, gte } from "drizzle-orm";
import { db, pool } from "../client";
import { appointments, doctorSlots, doctors, patients } from "../schema";
import { invalidateDoctorWeekCache } from "./slots";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Book a slot atomically. Cache is NEVER trusted for the write path — we
 * re-check `isBooked` straight from Postgres inside a transaction with a
 * row lock, so two callers racing for the same slot can't both succeed.
 * The 7-day slot cache for this doctor is invalidated immediately after,
 * so the next read repopulates from fresh DB state.
 */
export async function bookSlot(params: {
  slotId: number;
  doctorId: number;
  patientName: string;
  patientPhone: string;
  reasonForVisit?: string;
}): Promise<
  | { ok: true; appointmentId: number }
  | { ok: false; reason: "slot_taken" | "slot_not_found" }
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const slotRes = await client.query(
      `SELECT id, is_booked FROM doctor_slots WHERE id = $1 FOR UPDATE`,
      [params.slotId]
    );
    if (slotRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "slot_not_found" };
    }
    if (slotRes.rows[0].is_booked) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "slot_taken" };
    }

    let patientRes = await client.query(
      `SELECT id FROM patients WHERE phone = $1 LIMIT 1`,
      [params.patientPhone]
    );
    let patientId: number;
    if (patientRes.rowCount && patientRes.rowCount > 0) {
      patientId = patientRes.rows[0].id;
    } else {
      const insertPatient = await client.query(
        `INSERT INTO patients (name, phone) VALUES ($1, $2) RETURNING id`,
        [params.patientName, params.patientPhone]
      );
      patientId = insertPatient.rows[0].id;
    }

    await client.query(`UPDATE doctor_slots SET is_booked = true WHERE id = $1`, [
      params.slotId,
    ]);

    const apptRes = await client.query(
      `INSERT INTO appointments (patient_id, doctor_id, slot_id, status, reason_for_visit)
       VALUES ($1, $2, $3, 'booked', $4) RETURNING id`,
      [patientId, params.doctorId, params.slotId, params.reasonForVisit ?? null]
    );

    await client.query("COMMIT");
    await invalidateDoctorWeekCache(params.doctorId);

    return { ok: true, appointmentId: apptRes.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Upcoming appointments for a patient by phone — always filtered from today, never scans past bookings. */
export async function getUpcomingAppointmentsByPhone(phone: string) {
  const rows = await db
    .select({
      appointmentId: appointments.id,
      status: appointments.status,
      doctorName: doctors.name,
      doctorId: doctors.id,
      specialization: doctors.specialization,
      slotDate: doctorSlots.slotDate,
      startTime: doctorSlots.startTime,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(doctors, eq(appointments.doctorId, doctors.id))
    .innerJoin(doctorSlots, eq(appointments.slotId, doctorSlots.id))
    .where(
      and(
        eq(patients.phone, phone),
        eq(appointments.status, "booked"),
        gte(doctorSlots.slotDate, todayISO())
      )
    )
    .orderBy(doctorSlots.slotDate, doctorSlots.startTime);

  return rows;
}

export async function cancelAppointment(
  appointmentId: number
): Promise<{ ok: boolean; doctorId?: number }> {
  const rows = await db
    .select({ doctorId: appointments.doctorId, slotId: appointments.slotId })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  if (rows.length === 0) return { ok: false };

  await db
    .update(appointments)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(eq(appointments.id, appointmentId));

  await db
    .update(doctorSlots)
    .set({ isBooked: false })
    .where(eq(doctorSlots.id, rows[0].slotId));

  await invalidateDoctorWeekCache(rows[0].doctorId);

  return { ok: true, doctorId: rows[0].doctorId };
}
