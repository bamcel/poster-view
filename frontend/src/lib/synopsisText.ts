/** Render provider descriptions as plain text, never executable HTML. */
export function synopsisText(value?: string | null): string {
  if (!value) return "";
  const document = new DOMParser().parseFromString(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(p|div)>/gi, "\n\n"), "text/html");
  document.querySelectorAll("script,style").forEach(node => node.remove());
  return (document.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
