// Entrypoint for the GitHub Actions job (workflow: share-image-backfill.yml).
// Drains every 'before' photo missing a share_path, then exits. No urgency
// driving this (a report page falls back to its 400px thumbnail meanwhile),
// so a plain schedule triggers it — no repository_dispatch wiring needed.

import { drainAll, makeRealDeps } from "./worker.js";

async function main(): Promise<void> {
  const deps = makeRealDeps();
  const results = await drainAll(deps);
  if (results.length === 0) {
    console.log("share-image-backfill: nothing to do");
    return;
  }
  for (const r of results) {
    if ("sharePath" in r) {
      console.log(`share-image-backfill: ${r.id} -> ${r.sharePath}`);
    } else if ("error" in r) {
      console.error(`share-image-backfill: ${r.id} FAILED — ${r.error}`);
    }
  }
  const failed = results.filter((r) => "error" in r).length;
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("share-image-backfill: fatal", err);
  process.exit(1);
});
