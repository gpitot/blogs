import { escapeXml, xhtml } from "./xhtml.ts";

export function coverXhtml(title: string, author: string): string {
  return xhtml(
    "Cover",
    `<h1>${escapeXml(title)}</h1>\n  <h2>by ${escapeXml(author)}</h2>`,
  );
}
