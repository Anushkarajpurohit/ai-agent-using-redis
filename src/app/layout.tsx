import "./globals.css";

export const metadata = {
  title: "Maya — Appointment Desk",
  description: "Speak to Maya to find doctors and book appointments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
