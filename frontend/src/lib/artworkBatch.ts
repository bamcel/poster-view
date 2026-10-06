export async function applyArtworkBatch<T>(items:T[],apply:(item:T)=>Promise<void>,progress:(processed:number)=>void){
 const failed:T[]=[];const errors:string[]=[];let completed=0;
 for(let index=0;index<items.length;index++){
  const item=items[index];
  for(let attempt=0;attempt<3;attempt++){
   try{await apply(item);completed++;break;}catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(attempt<2&&/timed out|timeout/i.test(message))continue;
    failed.push(item);errors.push(message);break;
   }
  }
  progress(index+1);
 }
 return {completed,failed,errors};
}
