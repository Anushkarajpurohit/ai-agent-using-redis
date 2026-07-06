import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { doctors } from "../schema";
import { cacheGet, cacheSet, CacheKeys } from "../../lib/cache";
import { DoctorRecord } from "../../agent/types";

const TTL_DOCTORS = parseInt(process.env.CACHE_TTL_DOCTORS || "600", 10);

/**
 * Get active doctors for a specialization. Cached because the doctor
 * roster for a given specialization changes rarely (admin-managed), so
 * repeated symptom queries in the same time window hit cache, not Postgres.
 */
export async function getDoctorsBySpecialization(
  specialization: string
): Promise<DoctorRecord[]> {
  const key = CacheKeys.doctorsBySpecialization(specialization);

  const cached = await cacheGet<DoctorRecord[]>(key);
  if (cached) return cached;

  const rows = await db
    .select({
      id: doctors.id,
      name: doctors.name,
      specialization: doctors.specialization,
      qualifications: doctors.qualifications,
      yearsExperience: doctors.yearsExperience,
      clinicName: doctors.clinicName,
      city: doctors.city,
      rating: doctors.rating,
    })
    .from(doctors)
    .where(and(eq(doctors.specialization, specialization), eq(doctors.active, true)))
    .orderBy(doctors.rating);

  await cacheSet(key, rows, TTL_DOCTORS);
  return rows;
}

export async function getDoctorById(doctorId: number): Promise<DoctorRecord | null> {
  const rows = await db
    .select({
      id: doctors.id,
      name: doctors.name,
      specialization: doctors.specialization,
      qualifications: doctors.qualifications,
      yearsExperience: doctors.yearsExperience,
      clinicName: doctors.clinicName,
      city: doctors.city,
      rating: doctors.rating,
    })
    .from(doctors)
    .where(eq(doctors.id, doctorId))
    .limit(1);

  return rows[0] ?? null;
}
