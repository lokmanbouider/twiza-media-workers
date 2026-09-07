// Entrypoint for the GitHub Actions job (workflow: share-card-renderer.yml).
// Drains every due share_card_job, then exits. Triggered by repository_dispatch
// when the DB has pending work (a pg_cron function pings the GitHub API).

import { drainAll, makeRealDeps } from "./worker.js";

async function main(): Promise<void> {
  const { deps, close } = await makeRealDeps();
  try {
    const results = await drainAll(deps);
    if (results.length === 0) {
      console.log("share-card-renderer: nothing to do");
      return;
    }
    for (const r of results) {
      if ("formats" in r) {
        console.log(`share-card-renderer: ${r.eventId} -> ${r.formats.join(", ")}`);
      } else if ("skipped" in r) {
        console.log(`share-card-renderer: ${r.eventId} skipped (${r.skipped})`);
      } else if ("error" in r) {
        console.error(`share-card-renderer: ${r.eventId} FAILED — ${r.error}`);
      }
    }
    const failed = results.filter((r) => "error" in r).length;
    if (failed > 0) process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("share-card-renderer: fatal", err);
  process.exit(1);
});
