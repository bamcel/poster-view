import {describe,it,expect} from "vitest";
import {createBandwidthDetector,createFragmentTransferSampler} from "./bandwidth";
describe("HLS bandwidth evidence",()=>{
 it("ignores first-byte and producer waits but measures a large fragment before completion",()=>{
  const sampler=createFragmentTransferSampler(),stats={loaded:0,aborted:false,loading:{first:0,end:0}};sampler.start(stats);expect(sampler.poll(10_000)).toBeNull();stats.loading.first=10_000;stats.loaded=20_000;expect(sampler.poll(11_000)).toBeNull();stats.loaded=270_000;expect(sampler.poll(12_000)).toEqual({bytes:250_000,bodyMilliseconds:1000});stats.loaded=520_000;expect(sampler.poll(13_000)).toEqual({bytes:250_000,bodyMilliseconds:1000});stats.loading.end=13_000;expect(sampler.finish(stats)).toBeNull();
 });
 it("requires sustained samples plus a real low-buffer stall and caps restarts",()=>{
  const detector=createBandwidthDetector();detector.reset(0);expect(detector.observe(250_000,1000,1000)).toBe(false);detector.observe(250_000,1000,9000);detector.observe(240_000,1000,10_000);expect(detector.recommend({now:10_000,requiredBitrate:8_000_000,bufferSeconds:10,stallMilliseconds:4000})).toBeNull();expect(detector.recommend({now:10_000,requiredBitrate:8_000_000,bufferSeconds:0,stallMilliseconds:2000})).toBeNull();expect(detector.recommend({now:10_000,requiredBitrate:8_000_000,bufferSeconds:0,stallMilliseconds:4000})).toBe(1_536_000);detector.accepted(10_000);detector.observe(250_000,1000,19_000);detector.observe(240_000,1000,20_000);expect(detector.recommend({now:20_000,requiredBitrate:8_000_000,bufferSeconds:0,stallMilliseconds:4000})).toBeNull();
 });
});
