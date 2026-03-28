import archiver from "archiver";
import { createWriteStream, mkdir } from "node:fs";
import path from "node:path";
import { extractArticle, type ExtractedArticle } from "./clean.ts";

async function fetchArticle(url: string) {
  const resp = await fetch(url);
  return extractArticle(await resp.text(), url);
}

function xhtml(title: string, body: string, attrs = "") {
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

async function createEpub(
  title: string,
  author: string,
  chapters: ExtractedArticle[],
) {
  const dir = `epubs/${title.toLowerCase().replace(/\s+/g, "_")}`;

  await Bun.write(`${dir}/mimetype`, "application/epub+zip");

  await Bun.write(
    `${dir}/META-INF/container.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  const chapterItems = chapters
    .map(
      (_, i) =>
        `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n    ");
  const spineItems = chapters
    .map((_, i) => `<itemref idref="ch${i + 1}"/>`)
    .join("\n    ");
  const date = new Date().toISOString().split("T")[0];

  await Bun.write(
    `${dir}/OEBPS/content.opf`,
    `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${crypto.randomUUID()}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
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
</package>`,
  );

  const tocLinks = chapters
    .map(
      (ch, i) =>
        `<li><a href="ch${i + 1}.xhtml">${ch.title || `Chapter ${i + 1}`}</a></li>`,
    )
    .join("\n      ");

  await Bun.write(
    `${dir}/OEBPS/nav.xhtml`,
    xhtml(
      "Table of Contents",
      `<nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      ${tocLinks}
    </ol>
  </nav>`,
      'xmlns:epub="http://www.idpf.org/2007/ops"',
    ),
  );

  await Bun.write(
    `${dir}/OEBPS/cover.xhtml`,
    xhtml("Cover", `<h1>${title}</h1>\n  <h2>by ${author}</h2>`),
  );

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]!;
    const chTitle = ch.title || `Chapter ${i + 1}`;
    const chAuthor = ch.byline || author;
    await Bun.write(
      `${dir}/OEBPS/ch${i + 1}.xhtml`,
      xhtml(
        chTitle,
        `<h1>${chTitle}</h1>\n  <h2>${chAuthor}</h2>\n  ${ch.content}`,
      ),
    );
  }

  await zipEpub(dir);
}

function zipEpub(dir: string) {
  Bun.write("epubs_zipped/.gitkeep", "");
  const outputPath = `epubs_zipped/${path.basename(dir)}.epub`;
  return new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver("zip");

    output.on("close", () => {
      console.log(`Created ${outputPath} (${archive.pointer()} bytes)`);
      resolve();
    });
    archive.on("error", reject);
    archive.pipe(output);

    archive.append("application/epub+zip", { name: "mimetype", store: true });
    archive.directory(path.join(dir, "META-INF"), "META-INF");
    archive.directory(path.join(dir, "OEBPS"), "OEBPS");
    archive.finalize();
  });
}

const article = await fetchArticle(
  "https://www.derekthompson.org/p/we-havent-seen-the-worst-of-what",
);

await createEpub(
  article.title || "Gambling",
  article.byline || "Derek Thompson",
  [article],
);
