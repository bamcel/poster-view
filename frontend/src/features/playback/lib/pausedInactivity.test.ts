import {expect,it} from "vitest";
import {createPausedInactivity} from "./pausedInactivity";
it("prompts only after paused inactivity and exits after the response deadline",()=>{
  const clock=createPausedInactivity();clock.pause(0);
  expect(clock.tick(299999,true,5,5)).toBeNull();expect(clock.tick(300000,true,5,5)).toBe("prompt");
  expect(clock.tick(599999,true,5,5)).toBeNull();expect(clock.tick(600000,true,5,5)).toBe("exit");
});
it("resets both paused and prompt deadlines on human interaction",()=>{
  const clock=createPausedInactivity();clock.pause(0);clock.interact(200000);
  expect(clock.tick(300000,true,5,5)).toBeNull();expect(clock.tick(500000,true,5,5)).toBe("prompt");clock.interact(700000);
  expect(clock.tick(800000,true,5,5)).toBeNull();expect(clock.tick(1000000,true,5,5)).toBe("exit");
});
it("never prompts during playing, startup, errors or disabled policy and starts pause fresh",()=>{
  const clock=createPausedInactivity();clock.pause(0);
  expect(clock.tick(3600000,false,5,5)).toBeNull();clock.pause(3600000);
  expect(clock.tick(3600001,true,5,5)).toBeNull();expect(clock.tick(7200000,true,0,5)).toBeNull();
  clock.reset();expect(clock.tick(7200001,true,5,5)).toBeNull();
});
