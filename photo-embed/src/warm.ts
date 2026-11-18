// Downloads the CLIP weights into MODEL_CACHE_DIR, nothing else (no secrets,
// no queue). photo-embed.yml runs it only when the weights cache missed, then
// saves the cache right away — so the save no longer depends on a photo being
// waiting (an empty queue never loads the model) nor on the drain succeeding
// (actions/cache only saves when the whole job passes).

import { MODEL_CACHE_DIR, MODEL_TAG, warmUp } from "./embed.js";

warmUp()
  .then(() => {
    console.log(`photo-embed: ${MODEL_TAG} ready in ${MODEL_CACHE_DIR}`);
  })
  .catch((err) => {
    console.error("photo-embed: model download failed", err);
    process.exit(1);
  });
