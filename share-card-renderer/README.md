# share-card-renderer (T5.4bis)

Drains `share_card_jobs` and renders the before/after share visual in the
three formats (9:16, 1:1, 1.91:1), uploading each to the `share-cards`
bucket. Ported from the retired Edge Function
(`supabase/functions/generate-share-card`) — **same queue RPCs, same bucket,
same immutable paths**. What changed:

- **Runtime**: a GitHub Actions runner, not a Supabase Edge Function. The
  render (layout + rasterise + JPEG-encode, ×3 formats) needs several
  seconds of CPU; Edge Functions kill anything that long (same wall Lot 4
  hit with `magick-wasm`).
- **Renderer**: headless Chromium (`playwright`) laying out HTML/CSS, then
  `sharp` for the JPEG. Chromium does real text shaping, so Arabic joins
  and RTL work — Satori could not even *parse* a real Arabic font
  (`lookupType: 5 - substFormat: 3`).

Not part of the pnpm workspace (native deps: Chromium, sharp). Its own
`npm` / `npm test`.

## How a card gets made

1. A report flips to `cleanup_status = 'cleaned'` → trigger
   `enqueue_share_card_job` queues/refreshes one job per action
   (`run_after` debounced ~2 min).
2. `pg_cron` job `dispatch-share-card-render` (every 2 min, pure in-DB)
   calls `public.dispatch_share_card_render()`: if a job is `pending` and
   due, it `POST`s a `repository_dispatch` (`event_type: render-share-cards`)
   to the GitHub API. No pending job → no-op → no Actions minutes burned.
3. `.github/workflows/share-card-renderer.yml` runs `npm run drain`, which
   loops `claim_share_card_job` → render → upload → `complete_share_card_job`
   until the queue is empty.

## One-time setup

### GitHub repository secrets (Settings → Secrets and variables → Actions)

| secret | value |
| --- | --- |
| `SUPABASE_URL` | hosted project URL, e.g. `https://xddrjdlddzkffmniueaw.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | hosted service-role key |

### Supabase vault secrets (SQL editor, hosted project)

The `dispatch-share-card-render` cron reads these; the migration does **not**
create them (they differ per environment, like `project_url` /
`service_role_key`):

```sql
select vault.create_secret('lokmanbouider/Application_Twiza', 'github_repo');
select vault.create_secret('<PAT>', 'github_dispatch_token');
```

`<PAT>` = a **fine-grained** GitHub personal access token, scoped to this
one repository, with **Contents: read and write** permission (that is what
the "Create a repository dispatch event" REST call requires). No other
scope. Rotate it like any secret.

### Local run

Node **22+** (`@supabase/supabase-js` needs a native `WebSocket`).

```bash
cd services/share-card-renderer
npm ci
npx playwright install --with-deps chromium
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=<local service key> \
npm run drain
```

## Fonts

`fonts/NotoSans-Regular.ttf` + `fonts/NotoNaskhArabic-Regular.ttf` (OFL 1.1,
from `github.com/notofonts/notofonts.github.io`) are committed and embedded
into every rendered document as `data:` URIs — hermetic, no host fontconfig
needed. To refresh:

```bash
curl -L -o fonts/NotoSans-Regular.ttf \
  https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf
curl -L -o fonts/NotoNaskhArabic-Regular.ttf \
  https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoNaskhArabic/hinted/ttf/NotoNaskhArabic-Regular.ttf
```
