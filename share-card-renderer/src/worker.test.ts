import { describe, expect, it, vi } from "vitest";
import type { CardData } from "./templates/shared.js";
import type { RenderedCard } from "./render.js";
import {
  type ContextRow,
  drainAll,
  type PairRow,
  runOnce,
  type ServiceClientLike,
  type WorkerDeps,
} from "./worker.js";

type Calls = { fn: string; params: Record<string, unknown> | undefined }[];

function fakeService(opts: {
  jobs?: ({ event_id: string } | null)[];
  pairs?: PairRow[];
  ctx?: Partial<ContextRow>;
  objects?: Record<string, number>;
  calls: Calls;
  uploads: { path: string; bytes: number }[];
}): ServiceClientLike {
  const jobQueue = [...(opts.jobs ?? [{ event_id: "e-1" }])];
  const objects = opts.objects ?? {
    "before/thumb/r-1.jpg": 8_000,
    "after/thumb/r-1.jpg": 8_400,
    "before/r-1.jpg": 40_000,
    "after/r-1.jpg": 42_000,
  };
  return {
    storage: {
      from() {
        return {
          download(path: string) {
            const size = objects[path];
            if (size === undefined) {
              return Promise.resolve({
                data: null,
                error: { message: "not found" },
              });
            }
            return Promise.resolve({
              data: new Blob([new Uint8Array(size)]),
              error: null,
            });
          },
          upload(path: string, body: Uint8Array) {
            opts.uploads.push({ path, bytes: body.byteLength });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    },
    rpc(fn: string, params?: Record<string, unknown>) {
      opts.calls.push({ fn, params });
      if (fn === "claim_share_card_job") {
        const next = jobQueue.length ? jobQueue.shift()! : null;
        return Promise.resolve({ data: next ? [next] : [], error: null });
      }
      if (fn === "event_pairs") {
        return Promise.resolve({ data: opts.pairs ?? [], error: null });
      }
      if (fn === "share_card_context") {
        return Promise.resolve({
          data: [{
            organizer_name: "Sara",
            event_title: "Nettoyage",
            commune: "Bab Ezzouar",
            wilaya: "Alger",
            scheduled_start: "2026-08-12T09:00:00.000Z",
            bags_collected: 12,
            participants_present: 8,
            cleaned_count: 2,
            organizer_locale: "fr",
            national_cleaned: 1247,
            ...opts.ctx,
          }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

const THREE_CARDS: RenderedCard[] = [
  { format: "9x16", jpeg: new Uint8Array(1234), width: 1080, height: 1920 },
  { format: "1x1", jpeg: new Uint8Array(1234), width: 1080, height: 1080 },
  { format: "1.91x1", jpeg: new Uint8Array(1234), width: 1200, height: 630 },
];

function makeDeps(
  service: ServiceClientLike,
  render: (d: CardData) => Promise<RenderedCard[]> = () => Promise.resolve(THREE_CARDS),
): WorkerDeps {
  return { getServiceClient: () => service, render };
}

const PAIR: PairRow = {
  report_id: "r-1",
  before_storage_path: "before/r-1.jpg",
  before_thumbnail_path: "before/thumb/r-1.jpg",
  after_storage_path: "after/r-1.jpg",
  after_thumbnail_path: "after/thumb/r-1.jpg",
};

describe("runOnce", () => {
  it("no due job -> claimed 0", async () => {
    const calls: Calls = [];
    const res = await runOnce(
      makeDeps(fakeService({ jobs: [null], calls, uploads: [] })),
    );
    expect(res).toEqual({ claimed: 0 });
  });

  it("renders the hero pair into 3 formats, uploads, records them", async () => {
    const calls: Calls = [];
    const uploads: { path: string; bytes: number }[] = [];
    let rendered: CardData | undefined;
    const service = fakeService({
      pairs: [PAIR, { ...PAIR, report_id: "r-2" }],
      calls,
      uploads,
    });
    const res = await runOnce(
      makeDeps(service, (d) => {
        rendered = d;
        return Promise.resolve(THREE_CARDS);
      }),
    );

    expect(res).toEqual({ claimed: 1, eventId: "e-1", formats: ["9x16", "1x1", "1.91x1"] });
    expect(uploads.map((u) => u.path)).toEqual([
      "e-1/9x16.jpg",
      "e-1/1x1.jpg",
      "e-1/1.91x1.jpg",
    ]);
    const complete = calls.find((c) => c.fn === "complete_share_card_job");
    const rows = complete?.params?.p_cards as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      format: "9x16",
      storage_path: "e-1/9x16.jpg",
      width: 1080,
      height: 1920,
      bytes: 1234,
    });
    expect(rendered?.beforeDataUri).toContain("data:image/jpeg;base64,");
    expect(rendered?.cleanedCount).toBe(2);
    expect(rendered?.nationalCleaned).toBe(1247);
  });

  it("embeds the full frames (1600 px), not the 400 px thumbnails", async () => {
    const calls: Calls = [];
    let rendered: CardData | undefined;
    const downloaded: string[] = [];
    const service = fakeService({
      pairs: [PAIR],
      calls,
      uploads: [],
    });
    const from = service.storage.from.bind(service.storage);
    service.storage.from = (bucket: string) => {
      const store = from(bucket);
      const download = store.download.bind(store);
      store.download = (path: string) => {
        downloaded.push(path);
        return download(path);
      };
      return store;
    };
    const res = await runOnce(
      makeDeps(service, (d) => {
        rendered = d;
        return Promise.resolve(THREE_CARDS);
      }),
    );
    expect("formats" in res).toBe(true);
    // The renderer (Chromium on a GitHub Actions runner) has no Satori/Edge
    // Function CPU budget to protect — using the thumbnail here would just
    // upscale a 400 px source into a 1080 px-wide pane (T5.4 decision B1 is
    // stale for this renderer).
    expect(downloaded).toEqual(["before/r-1.jpg", "after/r-1.jpg"]);
    expect(rendered?.beforeDataUri).toContain("data:image/jpeg;base64,");
    expect(rendered?.afterDataUri).toContain("data:image/jpeg;base64,");
  });

  it("falls back to the thumbnail when the full frame path is missing", async () => {
    const calls: Calls = [];
    let rendered: CardData | undefined;
    const service = fakeService({
      pairs: [{ ...PAIR, before_storage_path: null, after_storage_path: null }],
      objects: { "before/thumb/r-1.jpg": 8_000, "after/thumb/r-1.jpg": 8_400 },
      calls,
      uploads: [],
    });
    const res = await runOnce(
      makeDeps(service, (d) => {
        rendered = d;
        return Promise.resolve(THREE_CARDS);
      }),
    );
    expect("formats" in res).toBe(true);
    expect(rendered?.beforeDataUri).toContain("data:image/jpeg;base64,");
    expect(rendered?.afterDataUri).toContain("data:image/jpeg;base64,");
  });

  it("a job with no pairs is completed with an error, not rendered", async () => {
    const calls: Calls = [];
    const render = vi.fn();
    const res = await runOnce(
      makeDeps(
        fakeService({ pairs: [], calls, uploads: [] }),
        render as unknown as (d: CardData) => Promise<RenderedCard[]>,
      ),
    );
    expect(res).toEqual({ claimed: 1, eventId: "e-1", skipped: "no_pairs" });
    expect(render).not.toHaveBeenCalled();
    const complete = calls.find((c) => c.fn === "complete_share_card_job");
    expect(complete?.params?.p_error).toBe("no_pairs");
  });

  it("a render failure is written back onto the job", async () => {
    const calls: Calls = [];
    const res = await runOnce(
      makeDeps(fakeService({ pairs: [PAIR], calls, uploads: [] }), () =>
        Promise.reject(new Error("chromium boom"))),
    );
    expect(res).toMatchObject({ claimed: 1, eventId: "e-1" });
    expect("error" in res && res.error).toContain("chromium boom");
    const complete = calls.find((c) => c.fn === "complete_share_card_job");
    expect(String(complete?.params?.p_error)).toContain("chromium boom");
  });
});

describe("drainAll", () => {
  it("processes every queued job then stops on empty", async () => {
    const calls: Calls = [];
    const results = await drainAll(
      makeDeps(fakeService({
        jobs: [{ event_id: "e-1" }, { event_id: "e-2" }, null],
        pairs: [PAIR],
        calls,
        uploads: [],
      })),
    );
    expect(results.map((r) => ("eventId" in r ? r.eventId : "?"))).toEqual([
      "e-1",
      "e-2",
    ]);
  });

  it("respects the max cap", async () => {
    const calls: Calls = [];
    const results = await drainAll(
      makeDeps(fakeService({
        jobs: Array(10).fill({ event_id: "e-x" }),
        pairs: [PAIR],
        calls,
        uploads: [],
      })),
      3,
    );
    expect(results).toHaveLength(3);
  });
});
