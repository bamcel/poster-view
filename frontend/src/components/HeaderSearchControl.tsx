import {useContext,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {HeaderSearchTarget} from "../lib/headerSearch";

export default function HeaderSearchControl({children}:{children:ReactNode}){
 const target=useContext(HeaderSearchTarget);
 return target?createPortal(<div className="flex min-w-0 flex-1 items-center justify-center">{children}</div>,target):children;
}
