import { db, pool } from "./client";
import { doctors, doctorSlots } from "./schema";

const SAMPLE_DOCTORS = [
  { name: "Dr. Priya Nair", specialization: "general medicine", qualifications: "MBBS, MD", yearsExperience: 12, clinicName: "City Health Clinic", city: "Pune", rating: 48 },
  { name: "Dr. Arjun Mehta", specialization: "general medicine", qualifications: "MBBS", yearsExperience: 6, clinicName: "Wellness Point", city: "Pune", rating: 44 },
  { name: "Dr. Sana Sheikh", specialization: "dermatology", qualifications: "MBBS, MD Dermatology", yearsExperience: 9, clinicName: "SkinCare Clinic", city: "Pune", rating: 47 },
  { name: "Dr. Rohan Kulkarni", specialization: "cardiology", qualifications: "MBBS, DM Cardiology", yearsExperience: 15, clinicName: "Heart Care Center", city: "Pune", rating: 49 },
  { name: "Dr. Neha Kapoor", specialization: "pediatrics", qualifications: "MBBS, MD Pediatrics", yearsExperience: 8, clinicName: "Little Steps Clinic", city: "Pune", rating: 46 },
];

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;
const SLOT_MINUTES = 30;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

async function main() {
  console.log("Seeding doctors...");
  const inserted = await db.insert(doctors).values(SAMPLE_DOCTORS).returning({ id: doctors.id });

  console.log("Generating 14 days of slots per doctor...");
  const today = new Date();
  const slotRows: (typeof doctorSlots.$inferInsert)[] = [];

  for (const { id: doctorId } of inserted) {
    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
      const date = new Date(today);
      date.setDate(date.getDate() + dayOffset);
      // skip Sundays
      if (date.getDay() === 0) continue;

      const dateStr = date.toISOString().slice(0, 10);
      for (let hour = WORK_START_HOUR; hour < WORK_END_HOUR; hour++) {
        for (let min = 0; min < 60; min += SLOT_MINUTES) {
          const start = `${pad(hour)}:${pad(min)}:00`;
          const endMin = min + SLOT_MINUTES;
          const end = `${pad(endMin >= 60 ? hour + 1 : hour)}:${pad(endMin % 60)}:00`;
          slotRows.push({
            doctorId,
            slotDate: dateStr,
            startTime: start,
            endTime: end,
            isBooked: false,
          });
        }
      }
    }
  }

  await db.insert(doctorSlots).values(slotRows);
  console.log(`Inserted ${inserted.length} doctors and ${slotRows.length} slots.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
