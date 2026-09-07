# share-image-backfill

Drains `claim_share_image_jobs`: for every `photos` row (`kind = 'before'`)
still missing `share_path`, downloads the already-uploaded full-resolution
photo, resizes it to 880px with `sharp`, uploads the result to
`share/<same filename>` in the `report-photos` bucket, and records the path
(`complete_share_image_job`).

This is a corrected follow-up to an earlier attempt at generating the same
image on the phone (`compressPhoto`, a third derived size next to the
thumbnail and full photo): that needed an app rebuild to take effect and
could never fix reports already published. Since the 880px image is just a
downscale of the full photo **already sitting in Storage**, no client is
needed at all — a small server-side job both avoids the rebuild and catches
every existing report on its first run.

**Runtime**: a GitHub Actions runner, not a Supabase Edge Function.
Decoding an image on a cold Edge worker has blown its ~2s CPU budget twice
on this project already (`magick-wasm`, then Satori — see
`packages/shared/src/media/compress-photo.ts` and
`services/share-card-renderer`). `sharp` here runs on an ordinary runner
with no such limit.

Not part of the pnpm workspace (native dep: `sharp`). Its own `npm` /
`npm test`.

## How it runs

No urgency drives this — a report's `/r/<id>` page falls back to its 400px
thumbnail until `share_path` is set, so a plain schedule is enough (unlike
`share-card-renderer`, there's no `pg_cron` → `repository_dispatch` wiring
here).

`.github/workflows/share-image-backfill.yml` runs `npm run drain` on a
schedule, which loops `claim_share_image_jobs` → download → resize → upload
→ `complete_share_image_job` until the queue is empty (capped at 50 photos
per run). A photo that fails 5 times in a row is left alone for good — it
just keeps showing its thumbnail, never a blocker.

## One-time setup

### GitHub repository secrets

Reuses the same two secrets already set up for `share-card-renderer`
(Settings → Secrets and variables → Actions):

| secret | value |
| --- | --- |
| `SUPABASE_URL` | hosted project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | hosted service-role key |

### Local run

Node **22+** (`@supabase/supabase-js` needs a native `WebSocket`).

```bash
cd services/share-image-backfill
npm ci
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=<local service key> \
npm run drain
```
