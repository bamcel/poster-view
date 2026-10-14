// Save progress first, but a stalled save must not hold an FFmpeg slot forever.
export async function stopAfterWatchReports(reports:Promise<unknown>,stop:()=>Promise<void>):Promise<void> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([reports.catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,3000);})]);
  } finally {
    clearTimeout(timer);
  }
  await stop().catch(()=>{});
}
