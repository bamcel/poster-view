export type BackdropLogo = {src:string;enabled:boolean;x:number;y:number;width:number;opacity:number};
export type BackdropFraming = {x:number;y:number;zoom:number;fit:"cover"|"contain";logo?:BackdropLogo};
export const defaultFraming:BackdropFraming={x:50,y:50,zoom:100,fit:"cover"};
export const backdropFramingEvent="posterview-backdrop-framing";
export function validBackdropLogo(value:unknown):value is BackdropLogo {
 const v=value as BackdropLogo|undefined;return !!v && typeof v.src==="string" && v.src.startsWith("/api/") && typeof v.enabled==="boolean" && [v.x,v.y,v.width,v.opacity].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=100);
}
export function validFraming(value:unknown):BackdropFraming|undefined {
 const v=value as BackdropFraming|undefined;
 return v && [v.x,v.y,v.zoom].every(n=>typeof n==="number" && Number.isFinite(n)) && v.x>=0 && v.x<=100 && v.y>=0 && v.y<=100 && v.zoom>=100 && v.zoom<=200 && ["cover","contain"].includes(v.fit) ? {...v,...(v.logo&&!validBackdropLogo(v.logo)?{logo:undefined}:{})} : undefined;
}
export function backdropFramingUrl(src:string|undefined,framing:unknown):string|undefined {
 if(!src)return src;
 const v=validFraming(framing);return v ? `${src}${src.includes("?")?"&":"?"}backdropEdit=${encodeURIComponent(JSON.stringify(v))}` : src;
}
export function connectedBackdropUrl(src:string|undefined,server:number,item:string):string|undefined {
 return src ? `${src}${src.includes("?")?"&":"?"}backdropKey=${encodeURIComponent(`posterview.backdropEdit.${server}.${item}`)}` : src;
}
export function framingFromUrl(src:string):BackdropFraming|undefined {
 try {const q=new URLSearchParams(src.split("?")[1]??"");const key=q.get("backdropKey");return validFraming(JSON.parse(q.get("backdropEdit") ?? (key ? localStorage.getItem(key) : null) ?? "null"));} catch{return undefined;}
}

// Framing is display metadata, not part of the image request/cache key.
export function backdropMediaUrl(src:string):string {
 const mark=src.indexOf("?");if(mark<0)return src;
 const query=src.slice(mark+1).split("&").filter(part=>! /^(backdropEdit|backdropKey)=/.test(part));
 return src.slice(0,mark)+(query.length?`?${query.join("&")}`:"");
}
