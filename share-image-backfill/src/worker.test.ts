import { describe, expect, it } from "vitest";
import {
  describeError,
  drainAll,
  isRetryableUploadError,
  type RunResult,
  runOnce,
  type ServiceClientLike,
  sharePathFor,
  type StorageErrorLike,
  type WorkerDeps,
} from "./worker.js";

type Calls = { fn: string; params: Record<string, unknown> | undefined }[];

function fakeService(opts: {
  jobs?: ({ id: string; storage_path: string } | null)[];
  objects?: Record<string, number>;
  calls: Calls;
  uploads: { path: string; bytes: number }[];
  /** One entry per upload() call, in order; missing/null = success. */
  uploadErrors?: (StorageErrorLike | null)[];
}): ServiceClientLike {
  const uploadErrors = [...(opts.uploadErrors ?? [])];
  const jobQueue = [...(opts.jobs ?? [{ id: "p-1", storage_path: "abc123.jpg" }])];
  const objects = opts.objects ?? { "abc123.jpg": 240_000 };
  return {
    storage: {
      from() {
        return {
          download(path: string) {
            const size = objects[path];
            if (size === undefined) {
              return Promise.resolve({ data: null, error: { message: "not found" } });
            }
            return Promise.resolve({ data: new Blob([new Uint8Array(size)]), error: null });
          },
          upload(path: string, body: Uint8Array) {
            opts.uploads.push({ path, bytes: body.byteLength });
            return Promise.resolve({ data: null, error: uploadErrors.shift() ?? null });
          },
        };
      },
    },
    rpc(fn: string, params?: Record<string, unknown>) {
      opts.calls.push({ fn, params });
      if (fn === "claim_share_image_jobs") {
        const next = jobQueue.length ? jobQueue.shift()! : null;
        return Promise.resolve({ data: next ? [next] : [], error: null });
      }
      if (fn === "complete_share_image_job") {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

const noSleep = () => Promise.resolve();

const fakeResize: WorkerDeps["resize"] = (bytes) =>
  Promise.resolve(new Uint8Array(Math.min(bytes.byteLength, 80_000)));

describe("sharePathFor", () => {
  it("mirrors the thumbnails/ convention under share/", () => {
    expect(sharePathFor("abc123.jpg")).toBe("share/abc123.jpg");
  });
});

describe("runOnce", () => {
  it("returns claimed: 0 when the queue is empty", async () => {
    const calls: Calls = [];
    const deps: WorkerDeps = {
      getServiceClient: () => fakeService({ jobs: [], calls, uploads: [] }),
      resize: fakeResize,
    };
    const result = await runOnce(deps);
    expect(result).toEqual({ claimed: 0 });
  });

  it("downloads the full photo, resizes it, uploads to share/, and completes the job", async () => {
    const calls: Calls = [];
    const uploads: { path: string; bytes: number }[] = [];
    const deps: WorkerDeps = {
      getServiceClient: () => fakeService({ calls, uploads }),
      resize: fakeResize,
    };

    const result = await runOnce(deps);

    expect(result).toEqual({ claimed: 1, id: "p-1", sharePath: "share/abc123.jpg" });
    expect(uploads).toEqual([{ path: "share/abc123.jpg", bytes: 80_000 }]);
    const complete = calls.find((c) => c.fn === "complete_share_image_job");
    expect(complete?.params).toEqual({ p_id: "p-1", p_share_path: "share/abc123.jpg" });
  });

  it("records the failure on the row when the source photo is missing", async () => {
    const calls: Calls = [];
    const deps: WorkerDeps = {
      getServiceClient: () =>
        fakeService({ objects: {}, calls, uploads: [] }),
      resize: fakeResize,
    };

    const result = await runOnce(deps);

    expect(result.claimed).toBe(1);
    expect((result as { error: string }).error).toMatch(/download abc123\.jpg/);
    const complete = calls.find((c) => c.fn === "complete_share_image_job");
    expect(complete?.params?.p_id).toBe("p-1");
    expect(complete?.params?.p_error).toMatch(/download abc123\.jpg/);
  });

  it("never throws — a resize failure is reported, not propagated", async () => {
    const calls: Calls = [];
    const deps: WorkerDeps = {
      getServiceClient: () => fakeService({ calls, uploads: [] }),
      resize: () => Promise.reject(new Error("corrupt jpeg")),
    };

    const result = await runOnce(deps);
    expect((result as { error: string }).error).toBe("corrupt jpeg");
  });
});

describe("describeError", () => {
  it("never returns an empty string", () => {
    expect(describeError(null)).toMatch(/no detail/);
    expect(describeError({ message: "" })).toMatch(/no detail/);
    expect(describeError({ message: "<none>" })).toMatch(/no detail/);
  });

  it("includes name, message, HTTP status and nested cause", () => {
    const err = {
      name: "StorageUnknownError",
      message: "fetch failed",
      status: 503,
      originalError: { message: "ECONNRESET" },
    };
    expect(describeError(err)).toBe(
      "StorageUnknownError — fetch failed — HTTP 503 — cause: ECONNRESET",
    );
  });

  it("reads a string statusCode", () => {
    expect(describeError({ message: "Payload too large", statusCode: "413" })).toBe(
      "Payload too large — HTTP 413",
    );
  });
});

describe("isRetryableUploadError", () => {
  it("retries network-level failures (no status) and 5xx/408/429", () => {
    expect(isRetryableUploadError({ message: "<none>" })).toBe(true);
    expect(isRetryableUploadError({ message: "x", status: 502 })).toBe(true);
    expect(isRetryableUploadError({ message: "x", status: 408 })).toBe(true);
    expect(isRetryableUploadError({ message: "x", statusCode: "429" })).toBe(true);
  });

  it("does not retry definitive 4xx answers", () => {
    expect(isRetryableUploadError({ message: "x", status: 400 })).toBe(false);
    expect(isRetryableUploadError({ message: "x", status: 403 })).toBe(false);
    expect(isRetryableUploadError({ message: "x", statusCode: "413" })).toBe(false);
  });
});

describe("runOnce — upload retries", () => {
  it("succeeds when a transient upload failure clears on retry", async () => {
    const calls: Calls = [];
    const uploads: { path: string; bytes: number }[] = [];
    const sleeps: number[] = [];
    const deps: WorkerDeps = {
      getServiceClient: () =>
        fakeService({ calls, uploads, uploadErrors: [{ message: "<none>" }, null] }),
      resize: fakeResize,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };

    const result = await runOnce(deps);

    expect(result).toEqual({ claimed: 1, id: "p-1", sharePath: "share/abc123.jpg" });
    expect(uploads).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    const complete = calls.find((c) => c.fn === "complete_share_image_job");
    expect(complete?.params).toEqual({ p_id: "p-1", p_share_path: "share/abc123.jpg" });
  });

  it("backs off exponentially and records every attempt when all fail", async () => {
    const calls: Calls = [];
    const uploads: { path: string; bytes: number }[] = [];
    const sleeps: number[] = [];
    const deps: WorkerDeps = {
      getServiceClient: () =>
        fakeService({
          calls,
          uploads,
          uploadErrors: [
            { message: "<none>" },
            { message: "bad gateway", status: 502 },
            { message: "bad gateway", status: 502 },
          ],
        }),
      resize: fakeResize,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };

    const result = await runOnce(deps);

    expect(uploads).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    const error = (result as { error: string }).error;
    expect(error).toMatch(/upload share\/abc123\.jpg failed after 3 attempt/);
    expect(error).toMatch(/#1: "<none>" — no detail/);
    expect(error).toMatch(/#3: bad gateway — HTTP 502/);
    const complete = calls.find((c) => c.fn === "complete_share_image_job");
    expect(complete?.params?.p_error).toMatch(/failed after 3 attempt/);
    expect(complete?.params).not.toHaveProperty("p_share_path");
  });

  it("gives up immediately on a definitive 4xx", async () => {
    const uploads: { path: string; bytes: number }[] = [];
    const deps: WorkerDeps = {
      getServiceClient: () =>
        fakeService({
          calls: [],
          uploads,
          uploadErrors: [{ message: "Payload too large", statusCode: "413" }],
        }),
      resize: fakeResize,
      sleep: noSleep,
    };

    const result = await runOnce(deps);

    expect(uploads).toHaveLength(1);
    expect((result as { error: string }).error).toMatch(
      /failed after 1 attempt.*Payload too large — HTTP 413/,
    );
  });

  it("treats a thrown upload (fetch failure) like a returned error", async () => {
    let calls = 0;
    const base = fakeService({ calls: [], uploads: [] });
    const service: ServiceClientLike = {
      ...base,
      storage: {
        from: () => ({
          ...base.storage.from("report-photos"),
          upload: () => {
            calls++;
            if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
            return Promise.resolve({ data: null, error: null });
          },
        }),
      },
    };
    const deps: WorkerDeps = {
      getServiceClient: () => service,
      resize: fakeResize,
      sleep: noSleep,
    };

    const result = await runOnce(deps);

    expect(calls).toBe(2);
    expect(result).toEqual({ claimed: 1, id: "p-1", sharePath: "share/abc123.jpg" });
  });
});

describe("drainAll", () => {
  it("drains every queued job until the queue is empty", async () => {
    const calls: Calls = [];
    const jobs = [
      { id: "p-1", storage_path: "a.jpg" },
      { id: "p-2", storage_path: "b.jpg" },
    ];
    // Built once and reused across calls — getServiceClient must return the
    // SAME instance every time, or each runOnce cycle sees the queue reset.
    const service = fakeService({
      jobs,
      objects: { "a.jpg": 100_000, "b.jpg": 100_000 },
      calls,
      uploads: [],
    });
    const deps: WorkerDeps = { getServiceClient: () => service, resize: fakeResize };

    const results: RunResult[] = await drainAll(deps);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.claimed === 1 && "sharePath" in r)).toBe(true);
  });

  it("stops at max without draining a still-nonempty queue", async () => {
    const calls: Calls = [];
    const jobs = Array.from({ length: 5 }, (_, i) => ({ id: `p-${i}`, storage_path: `${i}.jpg` }));
    const objects = Object.fromEntries(jobs.map((j) => [j.storage_path, 100_000]));
    const service = fakeService({ jobs, objects, calls, uploads: [] });
    const deps: WorkerDeps = { getServiceClient: () => service, resize: fakeResize };

    const results = await drainAll(deps, 2);
    expect(results).toHaveLength(2);
  });
});

describe("makeRealDeps", () => {
  it("throws without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", async () => {
    const { realServiceClient } = await import("./worker.js");
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      expect(() => realServiceClient()).toThrow(/SUPABASE_URL/);
    } finally {
      if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
      if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    }
  });
});
