import sanitizeHtml from "sanitize-html";
import archiver from "archiver";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import fs from "fs";

async function fetchUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  return sanitizeHtml(await resp.text());
}

function createEpub(title: string, author: string, chapters: string[]) {
  const dir = title.toLowerCase().replace(/\s+/g, "_");
  const cwd = `epubs/${dir}`;
  mkdirSync(cwd);
  mkdirSync(`${cwd}/META-INF`);
  mkdirSync(`${cwd}/OEBPS`);
  writeFileSync(`${cwd}/mimetype`, "application/epub+zip");

  const meta = `
        <?xml version="1.0" encoding="UTF-8"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
            <rootfile full-path="OEBPS/content.opf"
                    media-type="application/oebps-package+xml"/>
        </rootfiles>
        </container>
    `;
  writeFileSync(`${cwd}/META-INF/container.xml`, meta);

  function writeContent() {
    const uniqueId = crypto.randomUUID();
    const content = `
    <?xml version="1.0" encoding="UTF-8"?>
    <package version="3.0"
            xmlns="http://www.idpf.org/2007/opf"
            unique-identifier="${dir}"
            xml:lang="en">

    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="${dir}">${uniqueId}</dc:identifier>
        <dc:title>${dir}</dc:title>
        <dc:creator id="author">${author}</dc:creator>
        <dc:language>en</dc:language>
        <dc:date>2024-01-15</dc:date>
        <meta property="dcterms:modified">2024-01-15T00:00:00Z</meta>
    </metadata>

    <manifest>
        <!-- Navigation document (required in EPUB 3) -->
        <item id="nav"
            href="nav.xhtml"
            media-type="application/xhtml+xml"
            properties="nav"/>

        <!-- Cover page -->
        <item id="cover"
            href="cover.xhtml"
            media-type="application/xhtml+xml"/>

        <!-- Chapters -->
        <item id="chapter1"
            href="chapter1.xhtml"
            media-type="application/xhtml+xml"/>
    </manifest>

    <spine>
        <!-- linear="no" means it's not part of the main reading flow -->
        <itemref idref="cover"   linear="no"/>
        <itemref idref="chapter1"/>
    </spine>

    </package>
    `;
    writeFileSync(`${cwd}/OEBPS/content.opf`, content);
  }

  writeContent();

  function writeNav() {
    const content = `
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml"
        xmlns:epub="http://www.idpf.org/2007/ops"
        xml:lang="en">
    <head>
        <meta charset="UTF-8"/>
        <title>Table of Contents</title>
    </head>
    <body>

        <!-- Required: the main TOC -->
        <nav epub:type="toc" id="toc">
        <h1>Contents</h1>
        <ol>
            <li><a href="chapter1.xhtml">Chapter 1: Introduction</a></li>
        </ol>
        </nav>
        
        <!-- Optional: landmarks (helps readers jump to key locations) -->
        <nav epub:type="landmarks" hidden="">
        <ol>
            <li><a epub:type="toc"        href="nav.xhtml#toc">Table of Contents</a></li>
            <li><a epub:type="bodymatter" href="chapter1.xhtml">Start of Content</a></li>
        </ol>
        </nav>

    </body>
    </html>
    `;
    writeFileSync(`${cwd}/OEBPS/nav.xhtml`, content);
  }
  writeNav();

  function writeChapter(chapter: string) {
    const content = `
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml"
        xml:lang="en">
    <head>
        <meta charset="UTF-8"/>
        <title>Chapter 1: Introduction</title>
    </head>
    <body>
        <h1>Chapter 1: Introduction</h1>
        <p>${chapter}</p>
    </body>
    </html>
    `;
    writeFileSync(`${cwd}/OEBPS/chapter1.xhtml`, content);
  }

  chapters.map((chapter) => writeChapter(chapter));

  function writeCover() {
    const content = `
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml"
        xml:lang="en">
    <head>
        <meta charset="UTF-8"/>
        <title>Cover</title>
    </head>
    <body>
        <h1>${title}</h1>
        <h2>by ${author}</h2>
    </body>
    </html>
    `;
    writeFileSync(`${cwd}/OEBPS/cover.xhtml`, content);
  }

  writeCover();

  zipEpub(dir);
}

function zipEpub(dir: string) {
  const outputPath = `epubs_zipped/${dir}.epub`;
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip");

    output.on("close", () => {
      console.log(`Created ${outputPath} (${archive.pointer()} bytes)`);
      resolve(undefined);
    });
    archive.on("error", reject);
    archive.pipe(output);

    // Step 1: mimetype first, uncompressed (store level 0)
    archive.append("application/epub+zip", {
      name: "mimetype",
      store: true, // no compression
    });

    // Step 2: everything else
    archive.directory(path.join("epubs", dir, "META-INF"), "META-INF");
    archive.directory(path.join("epubs", dir, "OEBPS"), "OEBPS");

    archive.finalize();
  });
}

createEpub("My Book Title", "Jane Smith", ["My book content"]);
