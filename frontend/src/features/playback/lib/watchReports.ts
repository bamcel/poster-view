const pending = new Map<string, Set<Promise<void>>>();
let accountEpoch = 0;

// A new player must not replace the watch token before its predecessor saves.
// Account changes discard this coordination state; private data is never stored.
if (typeof window !== "undefined") {
  window.addEventListener("posterview:account-changed", () => {
    accountEpoch += 1;
    pending.clear();
  });
}

export function trackWatchReport(item: string, report: Promise<void>) {
  let reports = pending.get(item);
  if (!reports) pending.set(item, reports = new Set());
  reports.add(report);
  const owned = reports;
  const release = () => {
    owned.delete(report);
    if (!owned.size && pending.get(item) === owned) pending.delete(item);
  };
  void report.then(release, release);
  return report;
}

export function finishWatchReports(item: string): Promise<void> {
  return Promise.all(Array.from(pending.get(item) ?? [])).then(() => {});
}

export async function waitForWatchReports(item: string, signal?: AbortSignal) {
  const epoch = accountEpoch;
  if (!pending.get(item)?.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  let accountChanged: (() => void) | undefined;
  try {
    await Promise.race([
      finishWatchReports(item),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Your previous watch progress is still saving. Retry playback shortly.")), 3000);
        accountChanged = () => reject(new DOMException("The active account changed.", "AbortError"));
        window.addEventListener("posterview:account-changed", accountChanged, { once: true });
        aborted = () => reject(new DOMException("Playback was canceled.", "AbortError"));
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      }),
    ]);
    if (epoch !== accountEpoch) throw new DOMException("The active account changed.", "AbortError");
  } finally {
    clearTimeout(timer);
    if (aborted) signal?.removeEventListener("abort", aborted);
    if (accountChanged) window.removeEventListener("posterview:account-changed", accountChanged);
  }
}
