import {useEffect,useId,useRef,type ReactNode} from "react";
import {createPortal} from "react-dom";
import {X} from "lucide-react";
import "./PopupPage.css";

let openPages=0;
let previousOverflow="";

type Props={portalContainer?:HTMLElement|null;ariaLabel?:string;closeDisabled?:boolean;plainClose?:boolean;title:string;titleActions?:ReactNode;description?:ReactNode;onClose:()=>void;children:ReactNode;navigation?:ReactNode;footer?:ReactNode;layout?:"page"|"compact";bodyClassName?:string;headerActions?:ReactNode;closeLabel?:string;backdrop?:ReactNode;dismissOnBackdrop?:boolean};

/** Feature content owns its data and actions; this shell owns modal geometry and dismissal. */
export default function PopupPage({portalContainer,ariaLabel,closeDisabled=false,plainClose=false,title,titleActions,description,onClose,children,navigation,footer,layout="page",bodyClassName="",headerActions,closeLabel,backdrop,dismissOnBackdrop=false}:Props){
 const dialog=useRef<HTMLDialogElement>(null),heading=useId(),descriptionId=useId();
 const close=useRef(onClose);close.current=onClose;
 useEffect(()=>{
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const element=dialog.current!;
  if(openPages++===0){previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";}
  element.showModal();
  (element.querySelector<HTMLElement>("[autofocus],input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled)")??element.querySelector<HTMLElement>("button:not(:disabled),a[href]"))?.focus();
  return()=>{element.close();if(--openPages===0)document.body.style.overflow=previousOverflow;if(opener?.isConnected)opener.focus();};
 },[]);
 return createPortal(<dialog ref={dialog} aria-label={ariaLabel??title} aria-labelledby={ariaLabel?undefined:heading} aria-describedby={description?descriptionId:undefined} aria-modal="true" data-popup-layout={layout} className="pv-popup-page pv-popup-shell" onKeyDown={event=>{
   if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(!closeDisabled)close.current();return;}
   if(event.key!=="Tab")return;
   const nodes=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(node=>!node.closest('[hidden],[inert]'));
   const first=nodes[0],last=nodes[nodes.length-1];
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }} onCancel={event=>{event.preventDefault();if(!closeDisabled)close.current();}} onClick={event=>{if(!closeDisabled&&dismissOnBackdrop&&event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close.current();}}}>
  {backdrop&&<div className="pv-popup-decoration" aria-hidden="true">{backdrop}</div>}
  <header className="pv-popup-header">
   <div className="min-w-0 flex-1"><div className="flex items-center gap-3"><h2 id={heading} className="text-lg font-semibold">{title}</h2>{titleActions}</div>{description&&<div id={descriptionId} className="mt-2 text-sm text-muted">{description}</div>}</div>
   {headerActions}<button type="button" aria-label={closeLabel??`Close ${title}`} disabled={closeDisabled} onClick={()=>close.current()} className={`pv-popup-close${plainClose?" pv-popup-close-plain":""}`} data-icon-button={plainClose?undefined:"true"}><X className="size-5" aria-hidden="true"/></button>
  </header>
  {navigation&&<nav className="pv-popup-navigation" aria-label={`${title} sections`}>{navigation}</nav>}
  <div className={`pv-popup-body ${bodyClassName}`}>{children}</div>
  {footer&&<footer className="pv-popup-footer">{footer}</footer>}
 </dialog>,portalContainer??document.body);
}
