import { zipSync, strToU8 } from "fflate";
import type { ExtractedArticle } from "./clean.ts";
import type { EpubImage } from "./images.ts";
import { escapeXml } from "../templates/xhtml.ts";
import { containerXml } from "../templates/container.xml.ts";
import { contentOpf } from "../templates/content-opf.ts";
import { navXhtml } from "../templates/nav.ts";
import { coverXhtml } from "../templates/cover.ts";
import { chapterXhtml } from "../templates/chapter.ts";

export function generateEpub(
  title: string,
  author: string,
  chapters: ExtractedArticle[],
  images: EpubImage[] = [],
): Uint8Array {
  const date = new Date().toISOString().split("T")[0]!;
  const uid = crypto.randomUUID();

  const chapterItems = chapters
    .map((_, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("\n    ");

  const spineItems = chapters
    .map((_, i) => `<itemref idref="ch${i + 1}"/>`)
    .join("\n    ");

  const tocLinks = chapters
    .map((ch, i) => `<li><a href="ch${i + 1}.xhtml">${escapeXml(ch.title || `Chapter ${i + 1}`)}</a></li>`)
    .join("\n      ");

  const imageItems = images
    .map((img) => `<item id="${img.filename.replace(".", "_")}" href="img/${img.filename}" media-type="${img.mediaType}"/>`)
    .join("\n    ");

  // Build file map - mimetype MUST be first and uncompressed per EPUB spec
  // V8 preserves string key insertion order, so object literal order is guaranteed
  const files: Parameters<typeof zipSync>[0] = {
    "mimetype": [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": [strToU8(containerXml()), {}],
    "OEBPS/content.opf": [strToU8(contentOpf({ uid, title, author, date, chapterItems, spineItems, imageItems })), {}],
    "OEBPS/nav.xhtml": [strToU8(navXhtml(tocLinks)), {}],
    "OEBPS/cover.xhtml": [strToU8(coverXhtml(title, author)), {}],
  };

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    const chTitle = ch.title || `Chapter ${i + 1}`;
    const chAuthor = ch.byline || author;
    files[`OEBPS/ch${i + 1}.xhtml`] = [
      strToU8(chapterXhtml(chTitle, chAuthor, ch.content)),
      {},
    ];
  }

  for (const img of images) {
    files[`OEBPS/img/${img.filename}`] = [img.data, {}];
  }

  return zipSync(files);
}
