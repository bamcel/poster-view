type Snapshot={position:number;paused:boolean;generation?:number;speed?:number};
type Pending={sending:Snapshot|null;queued:Snapshot|null};

export function createSessionHeartbeatQueue(send:(session:string,position:number,paused:boolean,generation?:number,speed?:number)=>Promise<void>) {
  const sessions=new Map<string,Pending>();
  const pump=(session:string,state:Pending,snapshot:Snapshot)=>{
    state.sending=snapshot;
    const sending=snapshot.generation===undefined&&snapshot.speed===undefined?send(session,snapshot.position,snapshot.paused):send(session,snapshot.position,snapshot.paused,snapshot.generation,snapshot.speed);
    void sending.catch(()=>{}).finally(()=>{
      state.sending=null;
      if(sessions.get(session)!==state)return;
      const queued=state.queued;state.queued=null;
      if(queued)pump(session,state,queued);
    });
  };
  return {
    request(session:string,position:number,paused:boolean,generation?:number,speed?:number){
      if(!Number.isFinite(position)||position<0)return;
      let state=sessions.get(session);
      if(!state){state={sending:null,queued:null};sessions.set(session,state);}
      // Capture the source epoch now. Looking it up when a queued request is
      // dispatched could stamp an old position with a new seek generation.
      const snapshot={position,paused,generation,speed};
      if(state.sending){
        // A newer Play replaces an unsent Pause. Keep at most one request in
        // flight per job so an older paused response cannot overwrite it.
        state.queued=state.sending.position===position&&state.sending.paused===paused&&state.sending.generation===generation&&state.sending.speed===speed?null:snapshot;
      }else pump(session,state,snapshot);
    },
    forget(session:string){sessions.delete(session);},
    clear(){sessions.clear();},
  };
}
