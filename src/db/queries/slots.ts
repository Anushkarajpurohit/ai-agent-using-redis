import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../client";
import { doctorSlots, doctors } from "../schema";
import { cacheGet, cacheSet, CacheKeys, cacheDel } from "../../lib/cache";
import { DoctorSlotsByDate, SlotRecord } from "../../agent/types";

const TTL_SLOTS = parseInt(process.env.CACHE_TTL_SLOTS || "300", 10);

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch (and cache) the next-7-day availability map for a doctor.
 *
 * This is the single most latency-sensitive query in the whole flow: the
 * moment a user picks a doctor, we want the full week of slots ready before
 * they even finish asking "what dates do you have?". So:
 *
 *   1. Always query from TODAY forward (never scan past dates) — this alone
 *      keeps the row scan small regardless of how much historical slot data
 *      accumulates.
 *   2. Cache the whole 7-day, all-slots-for-doctor result as ONE cache
 *      entry keyed by (doctorId, today's date), so date + time selection
 *      later in the conversation are pure cache reads with zero DB hits.
 *   3. Short TTL (default 5 min) because slots can be booked by other users
 *      concurrently — we trade a little staleness for a lot of speed, and
 *      the actual booking step always re-validates against Postgres before
 *      committing (see queries/appointments.ts).
 */
export async function getDoctorWeekAvailability(doctorId: number): Promise<DoctorSlotsByDate> {
  const from = todayISO();
  const to = addDaysISO(from, 7);
  const key = CacheKeys.doctorSlots7Day(doctorId, from);

  const cached = await cacheGet<DoctorSlotsByDate>(key);
  if (cached) return cached;

  const doctorRow = await db
    .select({ name: doctors.name })
    .from(doctors)
    .where(eq(doctors.id, doctorId))
    .limit(1);

  const rows = await db
    .select({
      id: doctorSlots.id,
      slotDate: doctorSlots.slotDate,
      startTime: doctorSlots.startTime,
      endTime: doctorSlots.endTime,
      isBooked: doctorSlots.isBooked,
    })
    .from(doctorSlots)
    .where(
      and(
        eq(doctorSlots.doctorId, doctorId),
        eq(doctorSlots.isBooked, false),
        gte(doctorSlots.slotDate, from), // never fetch past dates
        lte(doctorSlots.slotDate, to)
      )
    )
    .orderBy(doctorSlots.slotDate, doctorSlots.startTime);

  const slotsByDate: Record<string, SlotRecord[]> = {};
  for (const row of rows) {
    const dateKey = row.slotDate as unknown as string;
    if (!slotsByDate[dateKey]) slotsByDate[dateKey] = [];
    slotsByDate[dateKey].push({
      id: row.id,
      slotDate: dateKey,
      startTime: row.startTime as unknown as string,
      endTime: row.endTime as unknown as string,
      isBooked: row.isBooked,
    });
  }

  const result: DoctorSlotsByDate = {
    doctorId,
    doctorName: doctorRow[0]?.name ?? "the doctor",
    slotsByDate,
    generatedAt: new Date().toISOString(),
  };

  await cacheSet(key, result, TTL_SLOTS);
  return result;
}

/** Call after a successful booking (or cancellation) so stale cached slots don't get re-offered. */
export async function invalidateDoctorWeekCache(doctorId: number): Promise<void> {
  const key = CacheKeys.doctorSlots7Day(doctorId, todayISO());
  await cacheDel(key);
}
