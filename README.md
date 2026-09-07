# twiza-media-workers

Jobs de traitement d'image pour [Application Twiza](https://github.com/lokmanbouider/Application_Twiza).
Sortis du dépôt principal (privé) pour tourner sur des runners GitHub Actions
gratuits — un dépôt **public** a des minutes Actions illimitées.

Ces services ne contiennent **aucun** schéma, aucune policy RLS, aucune
logique métier ou anti-abus : uniquement du Node + `sharp` / Chromium qui
lit une file d'attente côté base et redimensionne / rend des images. Toute
la logique de file (`share_card_jobs`, `claim_share_image_jobs`,
`complete_share_image_job`, …) vit dans le dépôt privé.

## Services

| Dossier | Rôle | Déclencheur |
|---|---|---|
| `share-card-renderer/` | Rend le visuel de partage avant/après en 3 formats via Chromium headless (`playwright`) + `sharp`. | `repository_dispatch: render-share-cards` (pg_cron `dispatch_share_card_render` quand `share_card_jobs` a du travail) + backstop `17 */6 * * *`. |
| `share-image-backfill/` | Réduit chaque photo « before » pleine résolution à 880 px (`sharp`) et la re-téléverse sous `share/`. | `repository_dispatch: drain-share-images` (pg_cron `dispatch_share_image_backfill` quand une photo attend) + backstop `41 4 * * *`. |

Pourquoi hors Edge Function : décoder / rasteriser une image sur un worker
Edge Supabase froid dépasse le budget CPU ~2 s (rencontré 2× sur ce projet,
`magick-wasm` puis Satori). Un runner GitHub Actions n'a pas cette
contrainte.

## Configuration (secrets Actions du dépôt)

Les deux workflows lisent :

- `SUPABASE_URL` — `https://<ref>.supabase.co` du projet hébergé
- `SUPABASE_SERVICE_ROLE_KEY` — clé `service_role` (Dashboard → Settings → API)

Côté base, les fonctions `dispatch_*` postent un `repository_dispatch` vers
ce dépôt en lisant deux secrets **vault** :

- `github_repo` = `lokmanbouider/twiza-media-workers`
- `github_dispatch_token` = PAT fine-grained limité à ce dépôt, permission
  *Contents: Read and write*

## Développement local

Chaque service est autonome (`npm`, hors workspace) :

```bash
cd share-image-backfill && npm ci && npm test
cd share-card-renderer  && npm ci && npm test
```
