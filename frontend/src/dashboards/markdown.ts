import DOMPurify from "dompurify";
import { marked } from "marked";

/** Markdown -> sanitized HTML for text tiles. Raw HTML in the markdown is sanitized too
 * (no scripts, event handlers or javascript: links); links open in a new tab. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  // Make links open in a new tab without giving the new page access to this one.
  const template = document.createElement("template");
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return template.innerHTML;
}
