const widths = [96, 192, 320, 480, 640, 1280, 1920];

/** Size native display artwork without changing external providers or original editor URLs. */
export function sizedArtwork(url: string, width: number): string {
  if (!/^\/api\/native\/libraries\/[^/]+\/items\/[^/]+\/artwork\/[^/?#]+(?:[?#]|$)/.test(url) || !Number.isFinite(width) || width <= 0) return url;
  const size = widths.find(value => value >= width) ?? widths[widths.length - 1];
  const hashAt = url.indexOf("#");
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const source = hashAt < 0 ? url : url.slice(0, hashAt);
  const mark = source.indexOf("?");
  const path = mark < 0 ? source : source.slice(0, mark);
  const query = mark < 0 ? [] : source.slice(mark + 1).split("&").filter(part => part && !/^width=/.test(part));
  return `${path}?${[...query, `width=${size}`].join("&")}${hash}`;
}
