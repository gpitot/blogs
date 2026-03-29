import { escapeXml, xhtml } from "./xhtml.ts";

export function chapterXhtml(title: string, author: string, content: string): string {
  return xhtml(
    title,
    `<h1>${escapeXml(title)}</h1>\n  <h2>${escapeXml(author)}</h2>\n  ${content}`,
  );
}
