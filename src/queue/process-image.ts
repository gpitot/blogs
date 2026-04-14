import type { Env } from "../repositories/types.ts";
import type { ProcessImageMsg } from "./types.ts";
import { KvJobRepo } from "../repositories/kv.ts";
import { processSingleImage } from "../services/images.ts";

/**
 * Process-image consumer. One invocation = one image, isolating the
 * Photon WASM resize + grayscale in its own 10ms CPU budget.
 * On failure the image is simply skipped — the assemble step will render
 * the article with a blank <img> for that index.
 */
export async function handleProcessImage(msg: ProcessImageMsg, env: Env): Promise<void> {
  const jobs = new KvJobRepo(env.EPUB_CACHE);

  const image = await processSingleImage(msg.url, msg.idx);
  if (!image) {
    // Store a "skipped" sentinel so listImageIndices still counts it toward
    // completeness — prevents the assemble step from waiting forever on
    // images that permanently fail.
    await jobs.putImage(msg.jobId, msg.idx, "", "image/jpeg", new Uint8Array(0));
    return;
  }

  await jobs.putImage(msg.jobId, msg.idx, image.filename, image.mediaType, image.data);
}
