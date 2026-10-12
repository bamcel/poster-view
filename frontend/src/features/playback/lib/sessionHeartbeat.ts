type Snapshot={position:number;paused:boolean};
type Pending={sending:Snapshot|null;queued:Snapshot|null};

export function createSessionHeartbeatQueue(send:(session:string,position:number,paused:boolean)=>Promise<void>) {
  const sessions=new Map<string,Pending>();
  const pump=(session:string,state:Pending,snapshot:Snapshot)=>{
    state.sending=snapshot;
    void send(session,snapshot.position,snapshot.paused).catch(()=>{}).finally(()=>{
      state.sending=null;
      if(sessions.get(session)!==state)return;
      const queued=state.queued;state.queued=null;
      if(queued)pump(session,state,queued);
    });
  };
  return {
    request(session:string,position:number,paused:boolean){
      if(!Number.isFinite(position)||position<0)return;
      let state=sessions.get(session);
      if(!state){state={sending:null,queued:null};sessions.set(session,state);}
      const snapshot={position,paused};
      if(state.sending){
        // A newer Play replaces an unsent Pause. Keep at most one request in
        // flight per job so an older paused response cannot overwrite it.
        state.queued=state.sending.position===position&&state.sending.paused===paused?null:snapshot;
      }else pump(session,state,snapshot);
    },
    forget(session:string){sessions.delete(session);},
    clear(){sessions.clear();},
  };
}
