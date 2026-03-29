import { xhtml } from "./xhtml.ts";

export function navXhtml(tocLinks: string): string {
  return xhtml(
    "Table of Contents",
    `<nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      ${tocLinks}
    </ol>
  </nav>`,
    'xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}
