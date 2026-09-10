# photo-embed

Drains `claim_photo_embed_jobs`: for every `photos` row (`kind = 'before'`)
whose `embedding` is still null, downloads the already-uploaded
full-resolution photo, computes a **CLIP ViT-B/32** image embedding
(512-dimensional, L2-normalised, q8-quantised weights via
[Transformers.js](https://github.com/huggingface/transformers.js)), and
records it (`complete_photo_embed_job`).

The embedding feeds two things on the moderation side (both in later tickets,
not here): near-duplicate detection more robust than the exact `photos.sha256`
check (crop / recompression), and a "similar reports" panel for moderators.

**Runtime**: a GitHub Actions runner, not a Supabase Edge Function. Running a
model — or just decoding an image — on a cold Edge worker has blown its ~2s
CPU budget twice on this project (`magick-wasm`, then Satori — see
`packages/shared/src/media/compress-photo.ts` and `share-card-renderer`). An
ordinary runner has no such limit.

Not part of the pnpm workspace (native deps: `onnxruntime-node`, `sharp`).
Its own `npm` / `npm test`.

## How it runs

No urgency drives this — dedup falls back to the exact SHA-256 check until an
embedding exists — but unlike `share-image-backfill` it *is* wired to
`pg_cron` → `repository_dispatch` so a new photo gets embedded within a few
minutes rather than once a day.

`public.dispatch_photo_embeddings()` (cron `*/5 * * * *`) pings the GitHub API
with `repository_dispatch: embed-photos` only when a `before` photo is waiting
under the attempt cap. `.github/workflows/photo-embed.yml` then runs
`npm run drain`, which loops `claim_photo_embed_jobs` → download → embed →
`complete_photo_embed_job` until the queue is empty (capped at 100 photos per
run; the 5-min cron drains a larger backlog over successive runs). A photo
that fails 5 times in a row is left alone for good — it just never gets an
embedding, never a blocker. The daily `schedule` in the workflow is a
backstop.

The first run after deploy embeds every existing `before` photo (the
`embedding is null` predicate picks them all up — no separate backfill
script).

## One-time setup

### GitHub repository secrets

Reuses the same two secrets already set up for the other workers
(Settings → Secrets and variables → Actions):

| secret | value |
| --- | --- |
| `SUPABASE_URL` | hosted project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | hosted service-role key |

The DB side reuses the existing vault secrets `github_repo` /
`github_dispatch_token` (shared with `dispatch_share_image_backfill`).

### Model weights

Transformers.js downloads `Xenova/clip-vit-base-patch32` (q8, ~90 MB) from the
Hugging Face Hub on first run. The workflow caches `~/.cache/huggingface`, so
steady-state runs do no download. To pin a different model or dtype, edit
`MODEL_ID` / `MODEL_DTYPE` in `src/embed.ts` and bump the cache key in the
workflow; `MODEL_TAG` is written to `photos.embed_model` so a later
`update … set embedding = null where embed_model <> '<new tag>'` re-enqueues
the affected rows.

### Local run

Node **22+** (`@supabase/supabase-js` needs a native `WebSocket`).

```bash
cd photo-embed
npm ci
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=<local service key> \
npm run drain
```
