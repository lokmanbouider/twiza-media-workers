import { describe, expect, it } from "vitest";
import { MODEL_TAG, toVectorLiteral } from "./embed.js";
import {
  drainAll,
  type RunResult,
  runOnce,
  type ServiceClientLike,
  type WorkerDeps,
} from "./worker.js";

type Calls = { fn: string; params: Record<string, unknown> | undefined }[];

function fakeService(opts: {
  jobs?: ({ id: string; storage_path: string } | null)[];
  objects?: Record<string, number>;
  calls: Calls;
}): ServiceClientLike {
  const jobQueue = [
    ...(opts.jobs ?? [{ id: "p-1", storage_path: "abc123.jpg" }]),
  ];
  const objects = opts.objects ?? { "abc123.jpg": 240_000 };
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
        };
      },
    },
    rpc(fn: string, params?: Record<string, unknown>) {
      opts.calls.push({ fn, params });
      if (fn === "claim_photo_embed_jobs") {
        const next = jobQueue.length ? jobQueue.shift()! : null;
        return Promise.resolve({ data: next ? [next] : [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

// 512 floats, all equal — toVectorLiteral turns it into the pgvector literal.
const fakeEmbed: WorkerDeps["embed"] = () =>
  Promise.resolve(new Array(512).fill(0.04419417));

describe("toVectorLiteral", () => {
  it("formats a vector as a pgvector text literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });
});

describe("runOnce", () => {
  it("returns claimed: 0 when the queue is empty", async () => {
    const calls: Calls = [];
    const deps: WorkerDeps = {
      getServiceClient: () => fakeService({ jobs: [], calls }),
      embed: fakeEmbed,
    };
    expect(await runOnce(deps)).toEqual({ claimed: 0 });
  });

  it("downloads the photo, embeds it, and completes the job", async () => {
    const calls: Calls = [];
    const deps: WorkerDeps = {
      getServiceClient: () => fakeService({ calls }),
      embed: fakeEmbed,
    };

    const result = await runOnce(deps);

    expect(result).toEqual({ claimed: 1, id: "p-1", dim: 512 });
    const complete = calls.find((c) => c.fn === "complete_photo_embed_job");
    expect(complete?.params?.p_id).toBe("p-1");
    expect(complete?.params?.p_model).toBe(MODEL_TAG);
    const literal = complete?.params?.p_embedding as string;
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    expect(literal.split(",")).toHaveLength(512);
  });

  it("records the failure on the row when the source photo is missing", async () => {
    const calls: Calls = [];
    const deps: WorkerDeps = {
      getServiceClient: () => fakeService({ objects: {}, calls }),
      embed: fakeEmbed,
    };

    const result = await runOnce(deps);

    expect(result.claimed).toBe(1);
    expect((result as { error: string }).error).toMatch(/download abc123\.jpg/);
    const complete = calls.find((c) => c.fn === "complete_photo_embed_job");
    expect(complete?.params?.p_id).toBe("p-1");
    expect(complete?.params?.p_error).toMatch(/download abc123\.jpg/);
  });

  it("never throws — an embed failure is reported, not propagated", async () => {
    const calls: Calls = [];
    const deps: WorkerDeps = {
      getServiceClient: () => fakeService({ calls }),
      embed: () => Promise.reject(new Error("corrupt jpeg")),
    };

    const result = await runOnce(deps);
    expect((result as { error: string }).error).toBe("corrupt jpeg");
    const complete = calls.find((c) => c.fn === "complete_photo_embed_job");
    expect(complete?.params?.p_error).toBe("corrupt jpeg");
  });
});

describe("drainAll", () => {
  it("drains every queued job until the queue is empty", async () => {
    const calls: Calls = [];
    const jobs = [
      { id: "p-1", storage_path: "a.jpg" },
      { id: "p-2", storage_path: "b.jpg" },
    ];
    // Built once and reused — getServiceClient must return the SAME instance
    // every cycle, or each runOnce sees the queue reset.
    const service = fakeService({
      jobs,
      objects: { "a.jpg": 100_000, "b.jpg": 100_000 },
      calls,
    });
    const deps: WorkerDeps = {
      getServiceClient: () => service,
      embed: fakeEmbed,
    };

    const results: RunResult[] = await drainAll(deps);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.claimed === 1 && "dim" in r)).toBe(true);
  });

  it("stops at max without draining a still-nonempty queue", async () => {
    const calls: Calls = [];
    const jobs = Array.from({ length: 5 }, (_, i) => ({
      id: `p-${i}`,
      storage_path: `${i}.jpg`,
    }));
    const objects = Object.fromEntries(jobs.map((j) => [j.storage_path, 100_000]));
    const service = fakeService({ jobs, objects, calls });
    const deps: WorkerDeps = {
      getServiceClient: () => service,
      embed: fakeEmbed,
    };

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
