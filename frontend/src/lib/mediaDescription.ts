import DOMPurify from "dompurify";

/** Provider synopsis markup rendered as plain text, never executable HTML. */
export function mediaDescription(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const clean=DOMPurify.sanitize(value.replace(/&lt;br\s*\/?\s*&gt;/gi,"\n").replace(/<\/(?:p|div)>/gi,"\n").replace(/<br\s*\/?\s*>/gi,"\n"),{ALLOWED_TAGS:[],ALLOWED_ATTR:[]});
  const doc=new DOMParser().parseFromString(clean,"text/html");
  return (doc.body.textContent ?? "").replace(/\r\n?/g,"\n").replace(/[\t ]*\n(?:[\t ]*\n)*[\t ]*/g,"\n").trim();
}
