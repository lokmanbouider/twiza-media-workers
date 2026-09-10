// Entrypoint for the GitHub Actions job (workflow: photo-embed.yml).
// Drains every 'before' photo missing an embedding, then exits. Real trigger:
// repository_dispatch (embed-photos) fired by the DB (pg_cron ->
// public.dispatch_photo_embeddings) only when a photo is actually waiting, so
// no Actions minutes are burned idle. The daily schedule is a backstop.

import { drainAll, makeRealDeps } from "./worker.js";

async function main(): Promise<void> {
  const deps = makeRealDeps();
  const results = await drainAll(deps);
  if (results.length === 0) {
    console.log("photo-embed: nothing to do");
    return;
  }
  for (const r of results) {
    if ("dim" in r) {
      console.log(`photo-embed: ${r.id} -> ${r.dim}-d`);
    } else if ("error" in r) {
      console.error(`photo-embed: ${r.id} FAILED — ${r.error}`);
    }
  }
  const failed = results.filter((r) => "error" in r).length;
  console.log(
    `photo-embed: ${results.length - failed} embedded, ${failed} failed`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("photo-embed: fatal", err);
  process.exit(1);
});
