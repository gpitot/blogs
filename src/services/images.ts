import { PhotonImage, grayscale, resize } from "@cf-wasm/photon/workerd";

export interface EpubImage {
  filename: string;
  data: Uint8Array;
  mediaType: "image/jpeg" | "image/svg+xml";
}

const MAX_WIDTH = 800;
const JPEG_QUALITY = 60;
const MAX_DOWNLOAD_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_IMAGES = 50;
const DOWNLOAD_TIMEOUT = 10_000; // 10s per image

/**
 * Placeholder inserted into article HTML for image `idx`. The assemble step
 * replaces these with `img/{actual filename}` once each image has been
 * downloaded and processed in its own queue invocation.
 */
export function imagePlaceholder(idx: number): string {
  return `__BLOGDL_IMG_${idx}__`;
}

/**
 * Walk the article HTML, collect absolute image URLs, and rewrite each `<img src>`
 * to a placeholder keyed by index. Pure CPU, but cheap (regex scan).
 *
 * Returns the rewritten HTML and the list of absolute URLs in insertion order.
 */
export function extractImageUrls(
  html: string,
  baseUrl: string,
): { html: string; urls: string[] } {
  const imgRegex = /<img\s[^>]*?src="([^"]+)"/g;
  const urls: string[] = [];
  const originals: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    if (urls.length >= MAX_IMAGES) break;
    const src = match[1]!;
    try {
      const absolute = src.startsWith("http") ? src : new URL(src, baseUrl).href;
      urls.push(absolute);
      originals.push(src);
    } catch {
      // invalid URL, skip — leave in-place
    }
  }

  let rewritten = html;
  for (let i = 0; i < originals.length; i++) {
    rewritten = rewritten.split(originals[i]!).join(imagePlaceholder(i));
  }
  return { html: rewritten, urls };
}

/**
 * Replace `__BLOGDL_IMG_{idx}__` placeholders with `img/{filename}` for each
 * image present in `filenamesByIdx`. Missing indices are replaced with empty
 * string (the `<img>` will render with no src — acceptable fallback).
 */
export function inlineImageFilenames(
  html: string,
  filenamesByIdx: Record<number, string>,
): string {
  return html.replace(/__BLOGDL_IMG_(\d+)__/g, (_m, idxStr) => {
    const idx = parseInt(idxStr, 10);
    const name = filenamesByIdx[idx];
    return name ? `img/${name}` : "";
  });
}

/**
 * Download + process a single image. Runs inside one queue invocation so it
 * gets its own CPU budget.
 *
 * Returns null for any failure (invalid URL, too large, non-image content-type,
 * photon failure). The caller should simply skip this index — the placeholder
 * will render with no src.
 */
export async function processSingleImage(
  url: string,
  idx: number,
): Promise<EpubImage | null> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogToEpub/1.0)" },
    });
  } catch {
    return null;
  }

  if (!resp.ok) return null;

  const contentLength = resp.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_DOWNLOAD_SIZE) return null;

  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return null;

  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength > MAX_DOWNLOAD_SIZE) return null;

  if (contentType.includes("svg")) {
    const filename = `img${String(idx + 1).padStart(3, "0")}.svg`;
    return { filename, data: new Uint8Array(buffer), mediaType: "image/svg+xml" };
  }

  try {
    const photonImg = PhotonImage.new_from_byteslice(new Uint8Array(buffer));
    const w = photonImg.get_width();
    const h = photonImg.get_height();
    let resized = photonImg;
    if (w > MAX_WIDTH) {
      const newH = Math.round((h / w) * MAX_WIDTH);
      resized = resize(photonImg, MAX_WIDTH, newH, 1); // 1 = bilinear
      photonImg.free();
    }
    grayscale(resized);
    const jpegBytes = resized.get_bytes_jpeg(JPEG_QUALITY);
    resized.free();
    const filename = `img${String(idx + 1).padStart(3, "0")}.jpg`;
    return { filename, data: jpegBytes, mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy synchronous helper — kept so on-demand download routes
// (/download/article/:id and /send-epub) still work without queuing.
// ---------------------------------------------------------------------------

export async function processArticleImages(
  html: string,
  baseUrl: string,
  startIndex = 0,
): Promise<{ html: string; images: EpubImage[] }> {
  const { html: rewritten, urls } = extractImageUrls(html, baseUrl);
  if (urls.length === 0) return { html: rewritten, images: [] };

  const results = await Promise.allSettled(
    urls.map((u, i) => processSingleImage(u, startIndex + i)),
  );

  const images: EpubImage[] = [];
  const byIdx: Record<number, string> = {};
  for (let i = 0; i < urls.length; i++) {
    const r = results[i]!;
    if (r.status !== "fulfilled" || !r.value) continue;
    images.push(r.value);
    byIdx[i] = r.value.filename;
  }
  return { html: inlineImageFilenames(rewritten, byIdx), images };
}
