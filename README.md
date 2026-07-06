# Maya — Voice Appointment Booking Agent

Maya is a deterministic-first, LLM-second medical receptionist. The LLM
(Ollama) never decides anything — it only turns pre-computed facts into a
natural spoken sentence.

## Architecture

```
Browser mic
   │
   ▼
SpeechRecognition (Web Speech API, on-device, IN THE BROWSER)
   │  (text — zero network hop)
   ▼
/api/chat  ──► agent/orchestrator.ts        <-- the ONLY network call in the whole voice loop
                 │
                 ├─ intent-classifier.ts   (regex/keyword, stage-aware — NO LLM)
                 ├─ specialization-map.ts  (symptom → specialty keyword table — NO LLM)
                 ├─ selectors.ts           (resolve "the second one" / "3pm" / "tomorrow" — NO LLM)
                 ├─ session-store.ts       (conversation state, cached)
                 ├─ db/queries/*           (Postgres via Drizzle, cache-aware)
                 └─ llm.ts                 (Ollama — phrasing ONLY, given a locked `facts` JSON)
   │  (reply text)
   ▼
speechSynthesis (Web Speech API, on-device, IN THE BROWSER)
   │  (zero network hop)
   ▼
Spoken response + chat bubble in UI
```

### Voice I/O: zero external latency by design

Earlier drafts of this project proxied audio to a self-hosted Whisper
server and a Coqui/Piper TTS server over HTTP. That works, but every extra
network hop (browser → Next.js → Python server → back) adds latency and
another process to keep alive — the opposite of what a "low latency,
conversational" receptionist needs.

Instead, voice runs **entirely in the browser** via the [Web Speech
API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API):

- **`SpeechRecognition`** — STT, handled by the browser/OS speech engine
  on-device. No audio ever leaves the browser as a file upload; you get a
  transcript directly, with no server round trip.
- **`speechSynthesis`** — TTS, also on-device. Maya's reply text is spoken
  immediately with no audio-generation wait at all.

The **only** network call in the entire voice turn is the single
`/api/chat` request — which is the one call that has to hit a server,
because that's where the DB, cache, and conversation state actually live.
Everything else (recording, transcription, speaking) is instant and free.

Trade-offs to know about:
- Supported in Chrome, Edge, and Safari; **not supported in Firefox** as of
  this writing. `ChatVoiceUI.tsx` detects this and falls back to the typed
  text input automatically.
- Voice quality/accent handling depends on the user's OS/browser speech
  engine rather than a model you control. If you later need higher
  accuracy (e.g. medical terms) or a specific voice/brand identity, you can
  reintroduce a self-hosted Whisper/Piper server behind the same
  `sendToAgent()` call — the orchestrator and caching layer don't change
  either way.

### Why "deterministic first, LLM second"

Every decision that matters for correctness — which specialization a
symptom maps to, which doctor/date/time the user picked, whether a slot is
actually free, whether to book/cancel — is handled by plain code: regex,
keyword tables, a state machine, and SQL transactions with row locks. The
LLM only ever receives a `TurnFacts` object (see `agent/types.ts`) that
already contains the full, correct outcome of the turn, and is instructed
to phrase it in 1-3 spoken sentences without inventing anything. If Ollama
is slow or down, `agent/llm.ts` falls back to deterministic string
templates so the booking flow never blocks on LLM availability.

### Caching strategy (Redis, with in-memory fallback)

- `doctors:spec:{specialization}` — doctor roster per specialty, TTL 10 min.
  Rarely changes, so most symptom queries are cache hits.
- `slots:doctor:{doctorId}:from:{today}` — the **entire next-7-day slot map**
  for a doctor, cached as one entry the moment the user picks that doctor.
  Every subsequent "what dates?" / "what times on that date?" question in
  the same conversation is then a pure cache read — zero DB round trips.
  TTL is short (5 min default) because slots can be booked concurrently.
- `session:{sessionId}` — the conversation state machine's accumulated
  "form" (symptom, doctor, date, slot, patient info), TTL 30 min.
- The **write path never trusts cache**: `bookSlot()` re-checks
  `is_booked` inside a Postgres transaction with `FOR UPDATE` before
  committing, and immediately invalidates the doctor's slot cache after a
  successful booking or cancellation.
- Every cache get/set/miss is logged to the console with a `[CACHE ...]`
  prefix so hit/miss behavior is visible during development.
- If `REDIS_URL` is unset or Redis is unreachable, `lib/cache.ts`
  transparently falls back to an in-process `Map` — the app keeps working
  (single-instance, no cross-request sharing) instead of failing.

### Query hygiene

All slot/appointment queries filter `slot_date >= CURRENT_DATE` (or the
JS-computed today string) at the SQL level, so historical rows are never
scanned regardless of how much data accumulates.

## Setup

```bash
cp .env.example .env.local   # fill in DATABASE_URL, REDIS_URL, OLLAMA_*, etc.
npm install
npm run db:generate
npm run db:migrate
npx tsx src/db/seed.ts        # sample doctors + 14 days of slots
npm run dev
```

You'll also need, running locally (or point the env vars at hosted versions):
- **Postgres** — the source of truth.
- **Redis** (optional) — for shared caching; falls back to in-memory otherwise.
- **Ollama** — `ollama pull phi3:mini && ollama serve`.

That's it for voice — no Whisper or TTS server to run. Open the app in
Chrome/Edge/Safari, tap the orb, and speak; the browser handles STT and TTS
natively. The UI falls back gracefully to the typed-text input on browsers
without Web Speech support (Firefox) or if mic permission is denied.

## Conversation flow example

```
User:  I have skin rashes
Maya:  [deterministic] rash -> dermatology  [DB, cache miss] doctors fetched, cached
       "For dermatology, I found Dr. Sana Sheikh. Would you like to book with her?"
User:  yes, book with dr sana
Maya:  [DB, cache miss] fetches + caches Dr. Sana's next-7-day slot map in ONE query
       "She's available Mon, Tue, Wed... which date works for you?"
User:  Wednesday
Maya:  [cache HIT — no DB call] "On Wednesday she has 9:30, 10:00, 2:15... which time?"
User:  2:15
Maya:  "Can I get your name?" -> "And your phone number?"
       -> confirms details -> [DB transaction, row lock] books it
       "You're all set — Dr. Sana Sheikh, Wednesday at 2:15 PM."
```

## Extending

- Add more specializations/keywords in `agent/specialization-map.ts`.
- Add more intents/regex in `agent/intent-classifier.ts`.
- Swap the LLM model via `OLLAMA_MODEL` in `.env.local` — it only affects
  phrasing quality, never correctness.
