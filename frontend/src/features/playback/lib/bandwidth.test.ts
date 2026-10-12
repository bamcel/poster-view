import {afterEach,describe,expect,it,vi} from "vitest";
import {createBandwidthDetector,createFragmentTransferSampler,measuredBodyBitsPerSecond,probeDirectBandwidth} from "./bandwidth";
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
const observation={now:12_000,requiredBitrate:10_000_000,bufferSeconds:1,stallMilliseconds:3_000};
function slowSamples(detector:ReturnType<typeof createBandwidthDetector>,now=10_000){detector.observe(500_000,1_000,now);detector.observe(500_000,1_000,now+1_000);}
describe("partial HLS transfer measurement",()=>{
 it("samples disjoint body windows before a huge fragment completes and never recounts the full fragment",()=>{
  const sampler=createFragmentTransferSampler(),stats={loaded:0,aborted:false,loading:{first:0,end:0}};sampler.start(stats);expect(sampler.poll(10_000)).toBeNull();expect(sampler.hasBody()).toBe(false);
  stats.loading.first=11_000;stats.loaded=500_000;expect(sampler.poll(12_000)).toBeNull();stats.loaded=1_000_000;expect(sampler.poll(13_000)).toEqual({bytes:500_000,bodyMilliseconds:1_000});stats.loaded=1_500_000;expect(sampler.poll(14_000)).toEqual({bytes:500_000,bodyMilliseconds:1_000});
  stats.loading.end=14_050;expect(sampler.finish(stats)).toBeNull();expect(sampler.finish(stats)).toBeNull();expect(sampler.poll(15_000)).toBeNull();
 });
 it("excludes zero-growth, first-byte wait, aborted/completed states and reset pause/seek windows",()=>{
  const sampler=createFragmentTransferSampler(),stats={loaded:0,aborted:false,loading:{first:0,end:0}};sampler.start(stats);expect(sampler.poll(5_000)).toBeNull();stats.loading.first=6_000;stats.loaded=50_000;expect(sampler.poll(6_000)).toBeNull();expect(sampler.poll(7_000)).toBeNull();stats.loaded=100_000;expect(sampler.poll(8_000)).toEqual({bytes:50_000,bodyMilliseconds:2_000});
  sampler.clearWindow();stats.loaded=500_000;expect(sampler.poll(20_000)).toBeNull();stats.loading.end=20_050;expect(sampler.finish(stats)).toBeNull();sampler.start(stats);stats.loading.end=0;stats.aborted=true;expect(sampler.poll(21_000)).toBeNull();expect(sampler.finish(stats)).toBeNull();
 });
 it("keeps the elapsed gap between network bursts in measured throughput",()=>{
  const sampler=createFragmentTransferSampler(),stats={loaded:500_000,aborted:false,loading:{first:1,end:0}};
  sampler.start(stats);sampler.poll(1_000);expect(sampler.poll(2_000)).toBeNull();expect(sampler.poll(3_000)).toBeNull();
  stats.loaded=1_000_000;const sample=sampler.poll(4_000)!;
  expect(measuredBodyBitsPerSecond(sample.bytes,sample.bodyMilliseconds)).toBeCloseTo(1_333_333.33);
 });
});
describe("measured bandwidth adaptation",()=>{
 it("ignores tiny or instantaneous transfers instead of treating cached/production timing as bandwidth",()=>{expect(measuredBodyBitsPerSecond(500_000,1_000)).toBe(4_000_000);expect(measuredBodyBitsPerSecond(1_000,1_000)).toBeNull();expect(measuredBodyBitsPerSecond(500_000,0)).toBeNull();expect(measuredBodyBitsPerSecond(500_000,99)).toBeNull();expect(measuredBodyBitsPerSecond(NaN,500)).toBeNull();});
 it("requires warmup, two slow body samples, and low-buffer sustained stalls",()=>{
  const detector=createBandwidthDetector();detector.reset(0);expect(detector.observe(500_000,1_000,1_000)).toBe(false);detector.observe(500_000,1_000,10_000);expect(detector.recommend(observation)).toBeNull();detector.observe(500_000,1_000,11_000);
  expect(detector.recommend({...observation,stallMilliseconds:2_000})).toBeNull();expect(detector.recommend({...observation,bufferSeconds:10})).toBeNull();expect(detector.recommend(observation)).toBe(3_200_000);
 });
 it("does not reduce bitrate from one poor sample followed by healthy throughput",()=>{const detector=createBandwidthDetector();detector.reset(0);detector.observe(500_000,1_000,10_000);detector.observe(2_000_000,1_000,11_000);expect(detector.recommend(observation)).toBeNull();});
 it("recognizes repeated underflows but rejects stale samples and an impossible bitrate floor",()=>{
  const detector=createBandwidthDetector();detector.reset(0);slowSamples(detector);detector.underflow(10_000);detector.underflow(11_000);expect(detector.recommend({...observation,stallMilliseconds:0})).toBe(3_200_000);expect(detector.recommend({...observation,now:60_000})).toBeNull();
  detector.observe(32_000,1_000,61_000);detector.observe(32_000,1_000,62_000);expect(detector.recommend({...observation,now:62_000})).toBeNull();
 });
 it("clears seek evidence without resetting the three-reduction limit or 45-second cooldown",()=>{
  const detector=createBandwidthDetector();detector.reset(0);let at=12_000;
  for(let index=0;index<3;index++){slowSamples(detector,at-2_000);expect(detector.recommend({...observation,now:at})).toBe(3_200_000);detector.accepted(at);slowSamples(detector,at+10_000);expect(detector.recommend({...observation,now:at+12_000})).toBeNull();detector.suppressUntil(at+20_000);expect(detector.recommend({...observation,now:at+45_000})).toBeNull();at+=50_000;}
  slowSamples(detector,at-2_000);expect(detector.recommend({...observation,now:at})).toBeNull();detector.reset(at);slowSamples(detector,at+9_000);expect(detector.recommend({...observation,now:at+12_000})).toBe(3_200_000);
 });
});
describe("bounded original-stream bandwidth probe",()=>{
 it("uses a same-origin authenticated 512 KiB Range and measures only response body duration",async()=>{
  const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(new Uint8Array(524_288),{status:206,headers:{"Content-Range":"bytes 100-524387/900000","Content-Length":"524288"}}));const clock=vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(1_100);
  expect(await probeDirectBandwidth("/api/playback/sessions/one/file",100,new AbortController().signal,clock)).toEqual({bytes:524_288,bodyMilliseconds:1_000});expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/playback/sessions/one/file"),expect.objectContaining({headers:{Range:"bytes=100-524387"},cache:"no-store",credentials:"same-origin"}));
 });
 it("cancels an ignored Range immediately and never consumes a full 200 response",async()=>{
  const cancel=vi.fn();vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(new ReadableStream({cancel}),{status:200}));expect(await probeDirectBandwidth("/file",0,new AbortController().signal)).toBeNull();expect(cancel).toHaveBeenCalledTimes(1);
 });
 it("rejects cross-origin URLs, invalid ranges, and oversized responses",async()=>{
  const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(new Uint8Array(32_000),{status:206,headers:{"Content-Range":"bytes 0-600000/900000","Content-Length":"600001"}}));expect(await probeDirectBandwidth("https://external.test/file",0,new AbortController().signal)).toBeNull();expect(fetcher).not.toHaveBeenCalled();expect(await probeDirectBandwidth("/file",0,new AbortController().signal)).toBeNull();
 });
 it("aborts an in-flight stalled body within eight seconds and honors session cancellation",async()=>{
  vi.useFakeTimers();const cancel=vi.fn();vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response(new ReadableStream({cancel}),{status:206,headers:{"Content-Range":"bytes 0-524287/900000"}}));
  const controller=new AbortController(),request=probeDirectBandwidth("/file",0,controller.signal);await Promise.resolve();await vi.advanceTimersByTimeAsync(8_000);expect(await request).toBeNull();expect(cancel).toHaveBeenCalledTimes(1);
  const second=probeDirectBandwidth("/file",0,controller.signal);await Promise.resolve();controller.abort();expect(await second).toBeNull();expect(cancel).toHaveBeenCalledTimes(2);
 });
});
