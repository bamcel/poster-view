import {createContext,useCallback,useContext,useLayoutEffect,useRef,type ReactNode} from "react";
import {useLocation,useNavigate,useNavigationType} from "react-router-dom";

type Entry={key:string;url:string};
const PlaybackReturnContext=createContext<((url:string)=>void)|null>(null);

/** Keep browse history available while the fullscreen player unmounts Layout. */
export function PlaybackNavigationProvider({children}:{children:ReactNode}) {
  const location=useLocation(),action=useNavigationType(),navigate=useNavigate();
  const history=useRef<{entries:Entry[];index:number}>({entries:[],index:-1});
  useLayoutEffect(()=>{
    const current=history.current;
    const entry={key:location.key,url:location.pathname+location.search+location.hash};
    const known=current.entries.findIndex(item=>item.key===entry.key);
    if(known>=0){current.index=known;return;}
    if(action==="REPLACE"&&current.index>=0){current.entries[current.index]=entry;return;}
    current.entries=current.entries.slice(0,current.index+1);
    current.entries.push(entry);
    current.index=current.entries.length-1;
  },[location.key,location.pathname,location.search,location.hash,action]);
  const returnTo=useCallback((url:string)=>{
    const current=history.current;
    for(let index=current.index-1;index>=0;index--){
      if(current.entries[index].url===url){void navigate(index-current.index);return;}
    }
    // Bookmarks and external/deep links have no known origin to pop back to.
    void navigate(url,{replace:true});
  },[navigate]);
  return <PlaybackReturnContext.Provider value={returnTo}>{children}</PlaybackReturnContext.Provider>;
}

export function usePlaybackReturn(returnPath:string) {
  const returnTo=useContext(PlaybackReturnContext),navigate=useNavigate();
  return ()=>{if(returnTo)returnTo(returnPath);else void navigate(returnPath,{replace:true});};
}
