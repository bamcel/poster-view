// Only bound waits for obsolete resources. Current probing/encoding preparation
// can legitimately take longer and continues under its existing owner.
export async function waitForPreviousPlayback(operation: Promise<void>, description: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} is still finishing. Retry playback shortly.`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
