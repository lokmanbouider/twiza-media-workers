// Drains claim_photo_embed_jobs. One cycle: claim a 'before' photo whose
// `embedding` is still null (claim_photo_embed_jobs, FOR UPDATE SKIP LOCKED
// under the hood), download its already-uploaded full-resolution photo from
// the report-photos bucket, compute a CLIP ViT-B/32 image embedding, and
// record it (complete_photo_embed_job). Any failure is written back onto the
// row (embed_error, embed_attempts) so a transient failure retries next run;
// a row stuck at 5 attempts is left alone for good — it just never gets an
// embedding, never a blocker (dedup falls back to the exact SHA-256 check).
//
// This job exists to keep model inference and image decoding OFF Supabase
// Edge Functions: doing that on a cold Edge worker has blown the ~2s CPU
// budget twice on this project (magick-wasm, then Satori). A GitHub Actions
// runner has no such budget.

import { createClient } from "@supabase/supabase-js";
import { embed as embedReal, MODEL_TAG, toVectorLiteral } from "./embed.js";

const BUCKET = "report-photos";
// Cap per run. The pg_cron dispatch fires every 5 min, so a larger backlog
// (e.g. the first backfill of existing photos) drains over a few runs.
const DRAIN_MAX = 100;

export type StorageLike = {
  download(
    path: string,
  ): Promise<{ data: Blob | null; error: { message: string } | null }>;
};

export type ServiceClientLike = {
  storage: { from(bucket: string): StorageLike };
  rpc(
    fn: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
};

export type ClaimedJob = { id: string; storage_path: string };

export type WorkerDeps = {
  getServiceClient: () => ServiceClientLike;
  embed: (bytes: Uint8Array) => Promise<number[]>;
};

export type RunResult =
  | { claimed: 0 }
  | { claimed: 1; id: string; dim: number }
  | { claimed: 1; id: string; error: string };

/** Processes at most one job. Returns what happened. Never throws. */
export async function runOnce(deps: WorkerDeps): Promise<RunResult> {
  const service = deps.getServiceClient();
  let id: string | null = null;

  try {
    const { data: claimed, error: claimError } = await service.rpc(
      "claim_photo_embed_jobs",
      { p_limit: 1 },
    );
    if (claimError) throw new Error(`claim: ${claimError.message}`);
    const job = (Array.isArray(claimed) ? claimed[0] : claimed) as
      | ClaimedJob
      | undefined;
    if (!job) return { claimed: 0 };
    id = job.id;

    const { data: full, error: downloadError } = await service.storage
      .from(BUCKET)
      .download(job.storage_path);
    if (downloadError || !full) {
      throw new Error(
        `download ${job.storage_path}: ${downloadError?.message ?? "not found"}`,
      );
    }

    const bytes = new Uint8Array(await full.arrayBuffer());
    const vector = await deps.embed(bytes);

    const { error: completeError } = await service.rpc(
      "complete_photo_embed_job",
      { p_id: id, p_embedding: toVectorLiteral(vector), p_model: MODEL_TAG },
    );
    if (completeError) throw new Error(`complete: ${completeError.message}`);

    return { claimed: 1, id, dim: vector.length };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (id) {
      try {
        await service.rpc("complete_photo_embed_job", {
          p_id: id,
          p_error: detail.slice(0, 500),
        });
      } catch {
        // best-effort — the row stays claimable again once embed_claimed_at
        // ages past the stuck-job timeout
      }
    }
    return { claimed: 1, id: id ?? "?", error: detail };
  }
}

/** Runs cycles until the queue is empty or `max` jobs have been handled. */
export async function drainAll(
  deps: WorkerDeps,
  max = DRAIN_MAX,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < max; i++) {
    const r = await runOnce(deps);
    if (r.claimed === 0) break;
    results.push(r);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

export function realServiceClient(): ServiceClientLike {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as ServiceClientLike;
}

export function makeRealDeps(): WorkerDeps {
  return { getServiceClient: realServiceClient, embed: embedReal };
}
