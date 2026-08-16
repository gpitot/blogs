import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import sanitizeHtml from "sanitize-html";
import { parseDocument } from "htmlparser2";
import render from "dom-serializer";
import { cleanByline, joinNames, resolveAuthor } from "./author.ts";

export interface ExtractedArticle {
  title: string;
  content: string;
  byline: string;
  /** Publication name, used as a byline fallback when no person is named. */
  siteName?: string;
}

/** Extract the canonical URL from a page's <link rel="canonical" href="...">. */
export function extractCanonicalUrl(html: string): string | null {
  const match = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
  );
  if (match) return match[1];
  // Also handle href before rel
  const match2 = html.match(
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
  );
  return match2 ? match2[1] : null;
}

/** Names out of a JSON-LD `author`, which may be a string, object, or array. */
function namesFromJsonLdAuthor(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(namesFromJsonLdAuthor);
  if (value && typeof value === "object") {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return [name];
  }
  return [];
}

/** Depth-first search of a JSON-LD blob for the first populated `author`. */
function findJsonLdAuthor(node: unknown): string {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findJsonLdAuthor(child);
      if (found) return found;
    }
    return "";
  }
  if (!node || typeof node !== "object") return "";

  const record = node as Record<string, unknown>;
  const direct = joinNames(namesFromJsonLdAuthor(record.author));
  if (direct) return direct;

  for (const key of ["@graph", "mainEntity", "mainEntityOfPage"]) {
    const found = findJsonLdAuthor(record[key]);
    if (found) return found;
  }
  return "";
}

interface MetaElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): MetaElement | null;
  textContent: string | null;
}

interface MetaDocument {
  querySelectorAll(selector: string): Iterable<MetaElement>;
}

/** Page metadata naming an author, in descending order of trustworthiness. */
const AUTHOR_META_SELECTORS = [
  'meta[name="author"]',
  'meta[property="author"]',
  'meta[name="parsely-author"]',
  // Frequently a profile URL rather than a name; cleanByline discards those.
  'meta[property="article:author"]',
];

const AUTHOR_ELEMENT_SELECTORS = ['[itemprop="author"]', '[rel~="author"]'];

/**
 * Recover an author from page metadata. Readability only inspects rel=author
 * and byline-ish class names, so it misses the tags below on a large fraction
 * of blogs — which is what leaves articles credited to nobody.
 */
function authorFromDocument(document: MetaDocument): string {
  for (const selector of AUTHOR_META_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const name = cleanByline(el.getAttribute("content"));
      if (name) return name;
    }
  }

  for (const el of document.querySelectorAll(
    'script[type="application/ld+json"]',
  )) {
    try {
      const found = findJsonLdAuthor(JSON.parse(el.textContent || ""));
      if (found) return found;
    } catch {
      /* a malformed block tells us nothing */
    }
  }

  for (const selector of AUTHOR_ELEMENT_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      // schema.org markup usually nests the name inside the author element.
      const nested = el.querySelector('[itemprop="name"]');
      const name = cleanByline(nested?.textContent ?? el.textContent);
      if (name) return name;
    }
  }

  // A social handle is a poor byline, so it is the last thing we accept.
  for (const el of document.querySelectorAll('meta[name="twitter:creator"]')) {
    const name = cleanByline(el.getAttribute("content")?.replace(/^@/, ""));
    if (name) return name;
  }

  return "";
}

function sanitizeFeedHtml(html: string, baseUrl: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      // HTML content
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "ul", "ol", "li",
      "blockquote", "pre", "code",
      "em", "strong", "b", "i", "u", "s", "sub", "sup",
      "a", "img",
      "figure", "figcaption",
      "table", "thead", "tbody", "tr", "th", "td",
      "div", "span",
      // SVG
      "svg", "path", "circle", "rect", "line", "polyline", "polygon",
      "ellipse", "g", "defs", "use", "text", "tspan", "style",
      "clippath", "mask", "marker", "pattern", "lineargradient",
      "radialgradient", "stop", "symbol", "title", "desc",
      // MathML
      "math", "mrow", "mi", "mo", "mn", "msup", "msub", "msubsup",
      "mfrac", "msqrt", "mroot", "mover", "munder", "munderover",
      "mtable", "mtr", "mtd", "mspace", "mtext", "menclose",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      svg: ["*"], path: ["*"], circle: ["*"], rect: ["*"], line: ["*"],
      polyline: ["*"], polygon: ["*"], ellipse: ["*"], g: ["*"], defs: ["*"],
      use: ["*"], text: ["*"], tspan: ["*"], style: ["*"], clippath: ["*"],
      mask: ["*"], marker: ["*"], pattern: ["*"], lineargradient: ["*"],
      radialgradient: ["*"], stop: ["*"], symbol: ["*"],
      math: ["*"], mrow: ["*"], mi: ["*"], mo: ["*"], mn: ["*"],
      msup: ["*"], msub: ["*"], msubsup: ["*"], mfrac: ["*"], msqrt: ["*"],
      mroot: ["*"], mover: ["*"], munder: ["*"], munderover: ["*"],
      mtable: ["*"], mtr: ["*"], mtd: ["*"], mspace: ["*"], mtext: ["*"],
      menclose: ["*"],
    },
    transformTags: {
      a: (tagName, attribs) => {
        if (attribs.href && !attribs.href.startsWith("http")) {
          try {
            attribs.href = new URL(attribs.href, baseUrl).href;
          } catch { /* ignore */ }
        }
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        if (attribs.src && !attribs.src.startsWith("http")) {
          try {
            attribs.src = new URL(attribs.src, baseUrl).href;
          } catch { /* ignore */ }
        }
        return { tagName, attribs };
      },
    },
    allowVulnerableTags: true,
    parser: { decodeEntities: true },
  });
}

/**
 * Sanitize inline feed content (from content:encoded / description / Atom content).
 * Skips Readability since the feed already provides the article body.
 */
export function extractArticleFromFeedContent(
  feedHtml: string,
  title: string,
  url: string,
  byline = "",
): ExtractedArticle {
  const cleaned = sanitizeFeedHtml(feedHtml, url);
  return {
    title,
    content: toXhtml(cleaned),
    byline: cleanByline(byline),
  };
}

export function extractArticle(rawHtml: string, url: string): ExtractedArticle {
  const { document } = parseHTML(rawHtml);

  Object.defineProperty(document, "documentURI", { value: url });

  // Readability strips <script> and rewrites the tree, so harvest the page's
  // author metadata before handing the document over.
  const metaAuthor = authorFromDocument(document as unknown as MetaDocument);

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Readability could not extract article from ${url}`);
  }

  const cleanedContent = sanitizeFeedHtml(article.content ?? "", url);

  return {
    title: article.title ?? "",
    content: toXhtml(cleanedContent),
    byline: resolveAuthor(article.byline, metaAuthor),
    siteName: cleanByline(article.siteName),
  };
}

// SVG attributes that require camelCase in XHTML (htmlparser2 lowercases them)
const SVG_ATTR_CASE: Record<string, string> = {
  viewbox: "viewBox",
  basefrequency: "baseFrequency",
  clippathunits: "clipPathUnits",
  diffuseconstant: "diffuseConstant",
  edgemode: "edgeMode",
  filterunits: "filterUnits",
  glyphref: "glyphRef",
  gradienttransform: "gradientTransform",
  gradientunits: "gradientUnits",
  kernelmatrix: "kernelMatrix",
  lengthadjust: "lengthAdjust",
  markerheight: "markerHeight",
  markerunits: "markerUnits",
  markerwidth: "markerWidth",
  maskcontentunits: "maskContentUnits",
  maskunits: "maskUnits",
  pathlength: "pathLength",
  patterncontentunits: "patternContentUnits",
  patterntransform: "patternTransform",
  patternunits: "patternUnits",
  pointsatx: "pointsAtX",
  pointsaty: "pointsAtY",
  pointsatz: "pointsAtZ",
  preserveaspectratio: "preserveAspectRatio",
  repeatcount: "repeatCount",
  repeatdur: "repeatDur",
  requiredextensions: "requiredExtensions",
  specularconstant: "specularConstant",
  specularexponent: "specularExponent",
  spreadmethod: "spreadMethod",
  startoffset: "startOffset",
  stddeviation: "stdDeviation",
  stitchtiles: "stitchTiles",
  surfacescale: "surfaceScale",
  textlength: "textLength",
  xchannelselector: "xChannelSelector",
  ychannelselector: "yChannelSelector",
};

// SVG/MathML tags that require camelCase in XHTML
const SVG_TAG_CASE: Record<string, string> = {
  clippath: "clipPath",
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  textpath: "textPath",
  foreignobject: "foreignObject",
  mathvariant: "mathvariant",
};

/** Convert HTML to valid XHTML using htmlparser2 + dom-serializer. */
function toXhtml(html: string): string {
  const dom = parseDocument(html);
  let xhtml = render(dom, { xmlMode: true });

  // Restore camelCase SVG attributes
  for (const [lower, correct] of Object.entries(SVG_ATTR_CASE)) {
    if (xhtml.includes(lower + "=")) {
      xhtml = xhtml.replaceAll(lower + "=", correct + "=");
    }
  }

  // Restore camelCase SVG/MathML tag names
  for (const [lower, correct] of Object.entries(SVG_TAG_CASE)) {
    if (xhtml.includes("<" + lower)) {
      xhtml = xhtml.replaceAll("<" + lower, "<" + correct);
      xhtml = xhtml.replaceAll("</" + lower, "</" + correct);
    }
  }

  return xhtml;
}
