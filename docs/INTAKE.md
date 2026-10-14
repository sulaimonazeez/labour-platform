# Request intake: guided questions + photo/video (added session 8)

Why: the platform should understand the problem, gather the details, then find the best provider (PRD §3, §17, §37, §141).
This slice is the "gather" step. The "match" step (`POST /requests/:id/match`, ranked providers with reasons) is NOT built yet.

## What exists
| Endpoint (all owner-only; writes need `Idempotency-Key`) | Does |
|---|---|
| `GET /requests/:id/questions` | The question set for the request's category (safety question first), each question's saved answer, `missingRequired`, and `emergency` |
| `PUT /requests/:id/answers` `{ "answers": { "<key>": value } }` | Saves/updates answers (partial is fine); returns all answers, `missingRequired`, `emergency` |
| `POST /requests/:id/attachments/upload-url` `{ kind, mimeType, sizeBytes, filename? }` | Creates a `pending` row and returns a signed upload URL: the DEVICE then PUTs the file straight to storage |
| `POST /requests/:id/attachments/:attId/confirm` `{ sha256? }` | Looks the object up in storage, records its real size, marks it `ready` |
| `GET /requests/:id/attachments` | Lists files; confirmed ones carry a 10-minute signed `downloadUrl` |
| `DELETE /requests/:id/attachments/:attId` | Removes the row and the stored object |

Files: `src/db/schema/intake.ts` (tables `request_answers`, `request_attachments`; enums `attachment_kind`, `attachment_status`),
`src/engine/intake-questions.ts` (pure: question sets, validation, safety flags, media rules),
`src/lib/storage.ts` (storage interface: supabase | memory | none), `src/api/intake-routes.ts`, `src/api/test-intake.ts`,
`src/storage-smoke.ts`.

## Decisions (labelled INTAKE-n so they cannot clash with the numbering in DECISIONS.md; copy them over if you want one list)
- INTAKE-1. Questions are deterministic stored sets per category, with the common ones appended (`urgency`, `site_type`, `details`).
  A safety question (`burning_or_sparks` for electrical, `water_near_electrics` for plumbing) leads its set. A dangerous answer sets
  `emergency.triggered` and returns the "contact local emergency services first; this platform is not an emergency service" message
  (PRD §80). No phone numbers: they differ by country. AI may reword or add questions later; the stored set must keep working without it.
- INTAKE-2. Media never passes through the API. Private bucket, signed upload URL, signed 10-minute download URL (PRD §132). The row is
  `pending` until `confirm` finds the object and records the REAL size; the client-claimed size is only a pre-check. The hash is
  client-reported and stored as such (PRD §67), never presented as proof.
- INTAKE-3. Caps (PRD §110): photo 10 MB (jpeg/png/webp/heic/heif), video 100 MB (mp4/mov/webm), document 15 MB (pdf), 12 files per request
  (`INTAKE_MAX_ATTACHMENTS`; abandoned pending uploads stop counting after 30 minutes). Executables and unknown types are refused.
- INTAKE-4. Owner-only for now (404 for everyone else). Providers must see a request's media only AFTER they are invited (PRD §40);
  that rule belongs to the matching step. Do not expose these endpoints to providers before that exists.
- INTAKE-5. Requests that are no longer draft/open/matched (e.g. converted) are closed to changes (409 `request_closed`) but readable.
- INTAKE-6. Photos from phones carry GPS in EXIF. Not stripped yet: the frontend should strip it before upload (PRD §40), or add a
  server step later. Until then treat attachments as sensitive.

## Run order (owner)
```bash
npm run db:generate      # expect one new migration: 2 enums + request_answers + request_attachments, nothing else; read it
npm run db:migrate
npm run db:lockdown      # expect 2 more tables defined, 0 without RLS
npm run typecheck
npm run test:intake      # uses in-memory storage: no Supabase storage needed
```
## Real storage (one-time, needed for the app, not for the tests)
1. Supabase dashboard > Storage > New bucket `request-media`, **Private** (do not tick Public).
2. Add to the server `.env` AND to the Vercel project settings: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Settings > API; this is a
   SECRET: server only, never in the web app or in git), optionally `STORAGE_BUCKET`.
3. `npm run storage:smoke`: all lines must say PASS. The Supabase REST calls in `storage.ts` were written from the documented API
   without network access, so this is the first real proof. Paste the output if anything FAILs.
4. Browser uploads go cross-origin to Supabase: if the browser blocks the PUT, check the bucket/CORS settings in Supabase.

## Not built yet (next)
1. `POST /requests/:id/match`: hard filters (category, active, credentials, area, availability) then an explainable score
   (distance, similar completed jobs, on-time/completion rate, response rate, review quality, price fit, language), fair boost for
   new providers (PRD §96), writes `request_candidates` (`invited`), returns the top few with reasons.
2. Frontend: guided questions one at a time, camera capture (`<input type="file" accept="image/*,video/*" capture>`), compress photos and
   strip GPS on the device, retry failed uploads, then the top-3 provider cards.
3. Provider-side view of a request's media after an invitation (INTAKE-4).
