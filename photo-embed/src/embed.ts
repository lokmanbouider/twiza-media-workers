// CLIP ViT-B/32 image embedding via Transformers.js (onnxruntime-node backend
// on Node 22). q8-quantised weights (~90MB) — cosine similarity between report
// photos is insensitive to the quantisation, and the smaller download keeps
// the Actions cache light. The processor reproduces CLIP's exact preprocessing
// (resize 224, center-crop, channel normalisation); Transformers.js decodes the
// JPEG bytes with its bundled `sharp`.
//
// Output: 512 floats, L2-normalised before it leaves this module — the CLIP
// convention, and it lets pgvector's <->, <#> and <=> operators be used
// interchangeably later.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  env,
  type Processor,
  RawImage,
} from "@huggingface/transformers";

// Where the downloaded weights land. Transformers.js ignores HF_HOME and, left
// alone, writes them inside its own package (node_modules/@huggingface/
// transformers/.cache/), which the workflow's actions/cache never saw — every
// run re-downloaded the ~90MB model. Pinned under ~/.cache/huggingface, the
// path photo-embed.yml caches.
export const MODEL_CACHE_DIR = join(
  homedir(),
  ".cache",
  "huggingface",
  "transformers.js",
);
env.cacheDir = MODEL_CACHE_DIR;

export const MODEL_ID = "Xenova/clip-vit-base-patch32";
export const MODEL_DTYPE = "q8";
// Written to photos.embed_model on every success so a future model/dtype swap
// can re-enqueue the affected rows (update ... set embedding = null where
// embed_model <> '<new tag>').
export const MODEL_TAG = `${MODEL_ID}@${MODEL_DTYPE}`;

export const EMBED_DIM = 512;

type VisionModel = Awaited<
  ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>
>;

let pipelinePromise: Promise<{ processor: Processor; model: VisionModel }> | null =
  null;

function loadPipeline(): Promise<{ processor: Processor; model: VisionModel }> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_ID),
        CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
          dtype: MODEL_DTYPE,
        }),
      ]);
      return { processor, model };
    })();
  }
  return pipelinePromise;
}

/**
 * Loads the processor and the model, downloading the weights into
 * MODEL_CACHE_DIR if they are not there yet. Run on its own by the workflow
 * when the cache misses, so the weights get cached even if the queue is empty
 * or the drain fails.
 */
export async function warmUp(): Promise<void> {
  await loadPipeline();
}

function l2normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("embedding has zero or non-finite norm");
  }
  return vec.map((x) => x / norm);
}

/**
 * Computes the L2-normalised CLIP image embedding for a JPEG/PNG byte buffer.
 * Throws on a decode failure or a degenerate embedding — the caller records
 * that on the row and the photo is retried on a later run.
 */
export async function embed(bytes: Uint8Array): Promise<number[]> {
  const { processor, model } = await loadPipeline();

  const image = await RawImage.fromBlob(new Blob([bytes]));
  const inputs = await processor(image);
  const output = await model(inputs);

  const data = output.image_embeds?.data as
    | Float32Array
    | number[]
    | undefined;
  if (!data || data.length !== EMBED_DIM) {
    throw new Error(
      `unexpected embedding shape: ${data ? data.length : "none"} (want ${EMBED_DIM})`,
    );
  }
  return l2normalize(Array.from(data));
}

/** pgvector text literal: "[0.1,0.2,...]" (what complete_photo_embed_job casts). */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
