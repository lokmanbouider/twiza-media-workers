// Drains share_card_jobs. One cycle: claim the oldest due job
// (claim_share_card_job, FOR UPDATE SKIP LOCKED), pull the action's pairs
// (event_pairs, T5.3) + context, render the "hero" pair (first) into the
// three formats, upload each to the share-cards bucket (immutable path), and
// record the rows (complete_share_card_job). Any failure is written back onto
// the job so the next run retries.
//
// Ported from the retired Edge Function — same queue RPCs, same bucket, same
// paths. Only the renderer (headless Chromium) and the runtime (a GitHub
// Actions runner) changed.

import { createClient } from "@supabase/supabase-js";
import type { CardData } from "./templates/shared.js";
import {
  encodeJpegReal,
  fontFaceCssReal,
  makeChromiumScreenshot,
  type RenderedCard,
  renderShareCards,
} from "./render.js";

const BUCKET_REPORTS = "report-photos";
const BUCKET_CARDS = "share-cards";

export type StorageLike = {
  download(
    path: string,
  ): Promise<{ data: Blob | null; error: { message: string } | null }>;
  upload(
    path: string,
    body: Uint8Array,
    opts: { contentType: string; upsert: boolean },
  ): Promise<{ data: unknown; error: { message: string } | null }>;
};

export type ServiceClientLike = {
  storage: { from(bucket: string): StorageLike };
  rpc(
    fn: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
};

export type PairRow = {
  report_id: string;
  before_storage_path: string | null;
  before_thumbnail_path: string | null;
  after_storage_path: string | null;
  after_thumbnail_path: string | null;
};

export type ContextRow = {
  organizer_name: string | null;
  event_title: string | null;
  commune: string | null;
  wilaya: string | null;
  scheduled_start: string | null;
  bags_collected: number | null;
  participants_present: number;
  cleaned_count: number;
  organizer_locale: string | null;
  national_cleaned: number | null;
};

export type WorkerDeps = {
  getServiceClient: () => ServiceClientLike;
  render: (data: CardData) => Promise<RenderedCard[]>;
};

export type RunResult =
  | { claimed: 0 }
  | { claimed: 1; eventId: string; formats: string[] }
  | { claimed: 1; eventId: string; skipped: string }
  | { claimed: 1; eventId: string; error: string };

async function toDataUri(
  storage: StorageLike,
  path: string | null,
): Promise<string> {
  if (!path) return "";
  const { data, error } = await storage.download(path);
  if (error || !data) {
    throw new Error(`missing photo ${path}: ${error?.message ?? "not found"}`);
  }
  const b64 = Buffer.from(await data.arrayBuffer()).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

/** Processes at most one job. Returns what happened. Never throws. */
export async function runOnce(deps: WorkerDeps): Promise<RunResult> {
  const service = deps.getServiceClient();
  let eventId: string | null = null;

  try {
    const { data: claimed, error: claimError } = await service.rpc(
      "claim_share_card_job",
      {},
    );
    if (claimError) throw new Error(`claim: ${claimError.message}`);
    const job = (Array.isArray(claimed) ? claimed[0] : claimed) as
      | { event_id: string }
      | undefined;
    if (!job) return { claimed: 0 };
    eventId = job.event_id;

    const [
      { data: pairsData, error: pairsError },
      { data: ctxData, error: ctxError },
    ] = await Promise.all([
      service.rpc("event_pairs", { p_event_id: eventId }),
      service.rpc("share_card_context", { p_event_id: eventId }),
    ]);
    if (pairsError) throw new Error(`event_pairs: ${pairsError.message}`);
    if (ctxError) throw new Error(`share_card_context: ${ctxError.message}`);

    const pairs = (pairsData ?? []) as PairRow[];
    if (pairs.length === 0) {
      await service.rpc("complete_share_card_job", {
        p_event_id: eventId,
        p_error: "no_pairs",
      });
      return { claimed: 1, eventId, skipped: "no_pairs" };
    }
    const ctx =
      ((Array.isArray(ctxData) ? ctxData[0] : ctxData) ?? {}) as ContextRow;
    const hero = pairs[0]!;

    const reports = service.storage.from(BUCKET_REPORTS);
    // Embed the full frames (≤1600 px), not the 400 px thumbnails: T5.4
    // decision B1 picked the thumbnail to keep Satori inside the Edge
    // Function's CPU budget, but that renderer was retired for B3 (Chromium
    // on a GitHub Actions runner, cf. T5.4bis) — no such budget here. Each
    // photo pane renders at 1080 px wide; a 400 px source gets upscaled
    // ~2.7x into it (soft/blurry), while the 1600 px source downscales
    // cleanly. Thumbnail stays as a fallback for the (should-not-happen)
    // case where the full path is missing.
    const [beforeDataUri, afterDataUri] = await Promise.all([
      toDataUri(reports, hero.before_storage_path ?? hero.before_thumbnail_path),
      toDataUri(reports, hero.after_storage_path ?? hero.after_thumbnail_path),
    ]);

    const data: CardData = {
      beforeDataUri,
      afterDataUri,
      title: ctx.event_title,
      commune: ctx.commune,
      wilaya: ctx.wilaya,
      dateIso: ctx.scheduled_start,
      participants: ctx.participants_present ?? 0,
      bags: ctx.bags_collected ?? 0,
      cleanedCount: ctx.cleaned_count ?? pairs.length,
      nationalCleaned: Number(ctx.national_cleaned ?? 0),
      organizerName: ctx.organizer_name,
      locale: ctx.organizer_locale ?? "fr",
    };

    const cards = await deps.render(data);
    const rows: Record<string, unknown>[] = [];
    for (const card of cards) {
      const path = `${eventId}/${card.format}.jpg`;
      const { error: upErr } = await service.storage
        .from(BUCKET_CARDS)
        .upload(path, card.jpeg, { contentType: "image/jpeg", upsert: true });
      if (upErr) throw new Error(`upload ${card.format}: ${upErr.message}`);
      rows.push({
        format: card.format,
        storage_path: path,
        width: card.width,
        height: card.height,
        bytes: card.jpeg.byteLength,
      });
    }

    await service.rpc("complete_share_card_job", {
      p_event_id: eventId,
      p_cards: rows,
    });
    return { claimed: 1, eventId, formats: cards.map((c) => c.format) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (eventId) {
      try {
        await service.rpc("complete_share_card_job", {
          p_event_id: eventId,
          p_error: detail.slice(0, 500),
        });
      } catch {
        // best-effort — the job stays claimable for the next run
      }
    }
    return { claimed: 1, eventId: eventId ?? "?", error: detail };
  }
}

/** Runs cycles until the queue is empty or `max` jobs have been handled. */
export async function drainAll(
  deps: WorkerDeps,
  max = 25,
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

/**
 * Real deps with a single Chromium shared across the drain. The caller must
 * invoke `close()` when done.
 */
export async function makeRealDeps(): Promise<{
  deps: WorkerDeps;
  close: () => Promise<void>;
}> {
  const { screenshot, close } = await makeChromiumScreenshot();
  const deps: WorkerDeps = {
    getServiceClient: realServiceClient,
    render: (data) =>
      renderShareCards(data, {
        screenshot,
        encodeJpeg: encodeJpegReal,
        fontFaceCss: fontFaceCssReal,
      }),
  };
  return { deps, close };
}
