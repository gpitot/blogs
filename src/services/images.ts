import sharp from "sharp";
import { createLogger } from "../logger.ts";

const logger = createLogger("images");

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
 * Download all images in the HTML, convert raster images to grayscale low-res JPEG,
 * include SVGs as-is, and rewrite src attributes to local EPUB paths.
 */
export async function processArticleImages(
  html: string,
  baseUrl: string,
  startIndex = 0,
): Promise<{ html: string; images: EpubImage[] }> {
  // Extract all img src URLs
  const imgRegex = /<img\s[^>]*?src="([^"]+)"/g;
  const urls: { original: string; absolute: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    if (urls.length >= MAX_IMAGES) break;
    const src = match[1]!;
    try {
      const absolute = src.startsWith("http")
        ? src
        : new URL(src, baseUrl).href;
      urls.push({ original: src, absolute });
    } catch {
      // invalid URL, skip
    }
  }

  if (urls.length === 0) return { html, images: [] };

  logger.debug({ baseUrl, imageCount: urls.length }, "Processing article images");

  // Download and process all images concurrently
  const results = await Promise.allSettled(
    urls.map((u, i) => downloadAndProcess(u.absolute, startIndex + i)),
  );

  const images: EpubImage[] = [];
  let processed = html;

  for (let i = 0; i < urls.length; i++) {
    const result = results[i]!;
    if (result.status !== "fulfilled" || !result.value) continue;

    const image = result.value;
    images.push(image);
    // Replace the src URL with the local EPUB path
    processed = processed
      .split(urls[i]!.original)
      .join(`img/${image.filename}`);
  }

  logger.debug({ baseUrl, processed: images.length, total: urls.length }, "Image processing complete");
  return { html: processed, images };
}

async function downloadAndProcess(
  url: string,
  index: number,
): Promise<EpubImage | null> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
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

  // SVGs: include as-is without raster processing
  if (contentType.includes("svg")) {
    const filename = `img${String(index + 1).padStart(3, "0")}.svg`;
    return {
      filename,
      data: new Uint8Array(buffer),
      mediaType: "image/svg+xml",
    };
  }

  try {
    const jpegBuffer = await sharp(Buffer.from(buffer))
      .resize(MAX_WIDTH, undefined, { withoutEnlargement: true })
      .grayscale()
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    const filename = `img${String(index + 1).padStart(3, "0")}.jpg`;
    return { filename, data: new Uint8Array(jpegBuffer), mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}
