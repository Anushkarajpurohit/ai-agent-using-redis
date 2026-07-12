import { db, pool } from "./client";
import { doctors, patients, doctorSlots } from "./schema";
import { eq } from "drizzle-orm";

async function seed() {
  console.log("Seeding...");
  console.log("DATABASE_URL:", process.env.DATABASE_URL);

  // Optional: clear existing data
  await db.delete(doctorSlots);
  await db.delete(patients);
  await db.delete(doctors);

  const insertedDoctors = await db
    .insert(doctors)
    .values([
      {
        name: "Dr. Neha Kapoor",
        specialization: "general_medicine",
        qualifications: "MBBS, MD",
        yearsExperience: 12,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 48,
      },
      {
        name: "Dr. Rahul Sharma",
        specialization: "cardiology",
        qualifications: "MBBS, DM Cardiology",
        yearsExperience: 15,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 49,
      },
      {
        name: "Dr. Priya Mehta",
        specialization: "dermatology",
        qualifications: "MBBS, MD Dermatology",
        yearsExperience: 11,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 47,
      },
      {
        name: "Dr. Amit Joshi",
        specialization: "orthopedics",
        qualifications: "MBBS, MS Orthopedics",
        yearsExperience: 18,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 48,
      },
      {
        name: "Dr. Sneha Kulkarni",
        specialization: "gynecology",
        qualifications: "MBBS, MS Obstetrics & Gynecology",
        yearsExperience: 14,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 49,
      },
      {
        name: "Dr. Arjun Deshmukh",
        specialization: "neurology",
        qualifications: "MBBS, DM Neurology",
        yearsExperience: 16,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 48,
      },
      {
        name: "Dr. Kavita Patil",
        specialization: "pediatrics",
        qualifications: "MBBS, MD Pediatrics",
        yearsExperience: 13,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 48,
      },
      {
        name: "Dr. Vikram Singh",
        specialization: "ent",
        qualifications: "MBBS, MS ENT",
        yearsExperience: 17,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 46,
      },
      {
        name: "Dr. Meera Shah",
        specialization: "ophthalmology",
        qualifications: "MBBS, MS Ophthalmology",
        yearsExperience: 12,
        clinicName: "City Care Clinic",
        city: "Pune",
        rating: 47,
      },
    ])
    .returning();

  await db.insert(patients).values([
    {
      name: "Anushka Rajpurohit",
      phone: "9876543210",
    },
    {
      name: "Rahul Verma",
      phone: "9876543211",
    },
  ]);

  const today = new Date();

  const slots = [];

  for (const doctor of insertedDoctors) {
    for (let d = 0; d < 10; d++) {
      const date = new Date(today);
      date.setDate(today.getDate() + d);

      const slotDate = date.toISOString().split("T")[0];

      for (let hour = 9; hour < 17; hour++) {
        for (const minute of [0, 30]) {
          const start = `${hour.toString().padStart(2, "0")}:${minute
            .toString()
            .padStart(2, "0")}:00`;

          const endDate = new Date();
          endDate.setHours(hour, minute + 30);

          const end = `${endDate
            .getHours()
            .toString()
            .padStart(2, "0")}:${endDate
              .getMinutes()
              .toString()
              .padStart(2, "0")}:00`;

          slots.push({
            doctorId: doctor.id,
            slotDate,
            startTime: start,
            endTime: end,
          });
        }
      }
    }
  }

  await db.insert(doctorSlots).values(slots);

  console.log(`Inserted ${insertedDoctors.length} doctors`);
  console.log(`Inserted ${slots.length} slots`);
}

seed()
  .then(() => {
    console.log("Done");
    process.exit(0);
  })
  .catch(console.error);