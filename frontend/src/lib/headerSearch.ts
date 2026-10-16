import {createContext} from "react";

// Pages retain ownership of search state while rendering their control in the app header.
export const HeaderSearchTarget=createContext<HTMLElement|null>(null);
