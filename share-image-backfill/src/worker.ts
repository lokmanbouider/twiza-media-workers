// Drains claim_share_image_jobs. One cycle: claim up to `limit` 'before'
// photos whose share_path is still null (claim_share_image_jobs, FOR UPDATE
// SKIP LOCKED under the hood), download each one's already-uploaded
// full-resolution photo from the report-photos bucket, resize it to 880px
// with sharp, upload the result to share/<same filename>, and record the
// path (complete_share_image_job). Any failure is written back onto the row
// (share_error, share_attempts) so a transient failure retries next run; a
// row stuck at 5 attempts is left alone for good — it just keeps falling
// back to its 400px thumbnail, never a blocker for the page.
//
// This whole job exists to keep image decoding OFF Supabase Edge Functions:
// instantiating an image codec on a cold Edge worker has blown the ~2s CPU
// budget twice on this project (magick-wasm, then Satori) — see
// packages/shared/src/media/compress-photo.ts and
// services/share-card-renderer for the two prior incidents. A GitHub
// Actions runner has no such budget.

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const BUCKET = "report-photos";
const SHARE_MAX_DIMENSION = 880;
const SHARE_QUALITY = 72; // sharp's jpeg quality is 0-100, not 0-1
const UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

// supabase-js StorageError: `message` can be empty or a placeholder on a
// network-level failure (the real reason lives in status / originalError).
export type StorageErrorLike = {
  message: string;
  name?: string;
  status?: number;
  statusCode?: string | number;
  originalError?: unknown;
  cause?: unknown;
};

export type StorageLike = {
  download(
    path: string,
  ): Promise<{ data: Blob | null; error: { message: string } | null }>;
  upload(
    path: string,
    body: Uint8Array,
    opts: { contentType: string; upsert: boolean },
  ): Promise<{ data: unknown; error: StorageErrorLike | null }>;
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
  resize: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** Injected so tests don't actually wait between upload retries. */
  sleep?: (ms: number) => Promise<void>;
};

export type RunResult =
  | { claimed: 0 }
  | { claimed: 1; id: string; sharePath: string }
  | { claimed: 1; id: string; error: string };

// 'before' photos are uploaded at the bucket root as "<clientId>.jpg" (see
// apps/mobile/src/features/sync/sync-worker.ts) — mirrors the existing
// "thumbnails/<...>" convention rather than inventing a new id.
export function sharePathFor(storagePath: string): string {
  const name = storagePath.split("/").pop();
  return `share/${name}`;
}


const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP status of a storage error, whichever field supabase-js filled in. */
function httpStatus(err: StorageErrorLike): number | undefined {
  const raw = err.status ?? err.statusCode;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * One readable line for an error, never empty: name, message, HTTP status and
 * the underlying cause. A run once failed with the bare message "<none>", which
 * made the cause impossible to tell from the logs.
 */
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return "unknown error (no detail)";
  if (typeof err === "string") return err.trim() || "unknown error (empty string)";
  if (typeof err !== "object") return String(err);

  const e = err as StorageErrorLike;
  const parts: string[] = [];
  const message = typeof e.message === "string" ? e.message.trim() : "";
  if (e.name && e.name !== "Error") parts.push(e.name);
  if (message && message !== "<none>") parts.push(message);
  const status = httpStatus(e);
  if (status !== undefined) parts.push(`HTTP ${status}`);
  const inner = e.originalError ?? e.cause;
  if (inner && inner !== err) parts.push(`cause: ${describeError(inner)}`);
  if (parts.length === 0) {
    let dump = "";
    try {
      const { message: _ignored, ...rest } = err as Record<string, unknown>;
      dump = JSON.stringify(rest);
    } catch {
      // circular — fall through
    }
    parts.push(
      dump && dump !== "{}" ? dump : `${message ? `"${message}" — ` : ""}no detail from the Storage client`,
    );
  }
  return parts.join(" — ");
}

/**
 * A 4xx (other than 408/429) is a definitive answer — bad path, auth, size —
 * and retrying it only burns time. No status at all means a network-level
 * failure, which is exactly what a retry is for.
 */
export function isRetryableUploadError(err: StorageErrorLike): boolean {
  const status = httpStatus(err);
  if (status === undefined) return true;
  return status >= 500 || status === 408 || status === 429;
}

/** Upload is `upsert: true`, so replaying it is idempotent. */
async function uploadWithRetry(
  storage: StorageLike,
  path: string,
  body: Uint8Array,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    let error: StorageErrorLike | null;
    try {
      ({ error } = await storage.upload(path, body, {
        contentType: "image/jpeg",
        upsert: true,
      }));
    } catch (thrown) {
      // supabase-js normally returns errors, but a fetch failure can still throw.
      error = thrown as StorageErrorLike;
    }
    if (!error) return;

    failures.push(`#${attempt}: ${describeError(error)}`);
    if (!isRetryableUploadError(error) || attempt === UPLOAD_ATTEMPTS) break;
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
  throw new Error(
    `upload ${path} failed after ${failures.length} attempt(s) — ${failures.join(" | ")}`,
  );
}

/** Processes at most one job. Returns what happened. Never throws. */
export async function runOnce(deps: WorkerDeps): Promise<RunResult> {
  const service = deps.getServiceClient();
  let id: string | null = null;

  try {
    const { data: claimed, error: claimError } = await service.rpc(
      "claim_share_image_jobs",
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
    const resized = await deps.resize(bytes);

    const sharePath = sharePathFor(job.storage_path);
    await uploadWithRetry(
      service.storage.from(BUCKET),
      sharePath,
      resized,
      deps.sleep ?? defaultSleep,
    );

    const { error: completeError } = await service.rpc("complete_share_image_job", {
      p_id: id,
      p_share_path: sharePath,
    });
    if (completeError) throw new Error(`complete: ${completeError.message}`);

    return { claimed: 1, id, sharePath };
  } catch (err) {
    const detail = err instanceof Error ? err.message : describeError(err);
    if (id) {
      try {
        await service.rpc("complete_share_image_job", {
          p_id: id,
          p_error: detail.slice(0, 500),
        });
      } catch {
        // best-effort — the row stays claimable again once share_claimed_at
        // ages past the stuck-job timeout
      }
    }
    return { claimed: 1, id: id ?? "?", error: detail };
  }
}

/** Runs cycles until the queue is empty or `max` jobs have been handled. */
export async function drainAll(deps: WorkerDeps, max = 50): Promise<RunResult[]> {
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

export async function resizeReal(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(Buffer.from(bytes))
    .resize(SHARE_MAX_DIMENSION, SHARE_MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: SHARE_QUALITY })
    .toBuffer();
  return new Uint8Array(out);
}

export function makeRealDeps(): WorkerDeps {
  return { getServiceClient: realServiceClient, resize: resizeReal };
}
