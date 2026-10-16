import {createContext} from "react";

/** Lets a page extend its backdrop behind the transparent app header. */
export const HeaderBackdropContext=createContext<((url:string|null)=>void)|null>(null);
export const headerBackdropStyle=(url:string)=>({backgroundImage:`linear-gradient(rgba(8,8,8,.72),rgba(8,8,8,.93)),url(${JSON.stringify(url)})`,backgroundSize:"cover",backgroundPosition:"center top",backgroundAttachment:"fixed"});
