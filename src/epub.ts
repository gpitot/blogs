import { zipSync, strToU8 } from "fflate";
import type { ExtractedArticle } from "./clean.ts";

function xhtml(title: string, body: string, attrs = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" ${attrs} xml:lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
</head>
<body>
  ${body}
</body>
</html>`;
}

export function generateEpub(
  title: string,
  author: string,
  chapters: ExtractedArticle[],
): Uint8Array {
  const date = new Date().toISOString().split("T")[0];
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

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uid}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    ${chapterItems}
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
    ${spineItems}
  </spine>
</package>`;

  const navXhtml = xhtml(
    "Table of Contents",
    `<nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      ${tocLinks}
    </ol>
  </nav>`,
    'xmlns:epub="http://www.idpf.org/2007/ops"',
  );

  const coverXhtml = xhtml(
    "Cover",
    `<h1>${escapeXml(title)}</h1>\n  <h2>by ${escapeXml(author)}</h2>`,
  );

  // Build file map - mimetype MUST be first and uncompressed per EPUB spec
  // V8 preserves string key insertion order, so object literal order is guaranteed
  const files: Parameters<typeof zipSync>[0] = {
    "mimetype": [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": [strToU8(containerXml), {}],
    "OEBPS/content.opf": [strToU8(contentOpf), {}],
    "OEBPS/nav.xhtml": [strToU8(navXhtml), {}],
    "OEBPS/cover.xhtml": [strToU8(coverXhtml), {}],
  };

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    const chTitle = ch.title || `Chapter ${i + 1}`;
    const chAuthor = ch.byline || author;
    files[`OEBPS/ch${i + 1}.xhtml`] = [
      strToU8(xhtml(
        chTitle,
        `<h1>${escapeXml(chTitle)}</h1>\n  <h2>${escapeXml(chAuthor)}</h2>\n  ${ch.content}`,
      )),
      {},
    ];
  }

  return zipSync(files);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
