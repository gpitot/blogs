import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import DOMPurify from "dompurify";

export interface ExtractedArticle {
  title: string;
  content: string;
  byline: string;
}

export function extractArticle(rawHtml: string, url: string): ExtractedArticle {
  const { document, window } = parseHTML(rawHtml);

  Object.defineProperty(document, "documentURI", { value: url });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new Readability(document as unknown as any);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Readability could not extract article from ${url}`);
  }

  // DOMPurify accepts any window-like object; linkedom's window satisfies this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const purify = DOMPurify(window as unknown as any);

  const cleanedContent = purify.sanitize(article.content ?? "", {
    ALLOWED_TAGS: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "ul", "ol", "li",
      "blockquote", "pre", "code",
      "em", "strong", "b", "i", "u", "s", "sub", "sup",
      "a", "img",
      "figure", "figcaption",
      "table", "thead", "tbody", "tr", "th", "td",
      "div", "span",
    ],
    ALLOWED_ATTR: ["href", "title", "src", "alt", "width", "height", "colspan", "rowspan"],
  });

  // Resolve relative URLs (replaces sanitize-html's transformTags)
  const { document: cleanDoc } = parseHTML(cleanedContent);
  for (const el of cleanDoc.querySelectorAll("a[href]")) {
    const href = el.getAttribute("href");
    if (href && !href.startsWith("http")) {
      try { el.setAttribute("href", new URL(href, url).href); } catch { /* ignore invalid URLs */ }
    }
  }
  for (const el of cleanDoc.querySelectorAll("img[src]")) {
    const src = el.getAttribute("src");
    if (src && !src.startsWith("http")) {
      try { el.setAttribute("src", new URL(src, url).href); } catch { /* ignore invalid URLs */ }
    }
  }

  const body = cleanDoc.querySelector("body");

  return {
    title: article.title ?? "",
    content: body?.innerHTML ?? cleanedContent,
    byline: article.byline ?? "",
  };
}
