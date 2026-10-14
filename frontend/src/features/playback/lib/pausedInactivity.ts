export function createPausedInactivity() {
  let pausedAt:number|null=null,promptAt:number|null=null;
  return {
    reset(){pausedAt=null;promptAt=null;},
    pause(now:number){pausedAt=now;promptAt=null;},
    interact(now:number){if(pausedAt!==null)pausedAt=now;if(promptAt!==null)promptAt=now;},
    tick(now:number,eligible:boolean,minutes:number,timeoutMinutes:number):"prompt"|"exit"|null {
      if(!eligible||minutes<=0){pausedAt=null;promptAt=null;return null;}
      if(pausedAt===null)pausedAt=now;
      if(promptAt!==null)return now-promptAt>=Math.max(1,timeoutMinutes)*60_000?"exit":null;
      if(now-pausedAt>=minutes*60_000){promptAt=now;return "prompt";}
      return null;
    },
  };
}
