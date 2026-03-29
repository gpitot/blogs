import { escapeXml } from "./xhtml.ts";

interface ContentOpfParams {
  uid: string;
  title: string;
  author: string;
  date: string;
  chapterItems: string;
  spineItems: string;
  imageItems?: string;
}

export function contentOpf({ uid, title, author, date, chapterItems, spineItems, imageItems }: ContentOpfParams): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
    ${imageItems ?? ""}
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
    ${spineItems}
  </spine>
</package>`;
}
