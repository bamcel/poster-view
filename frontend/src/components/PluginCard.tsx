import type {ReactNode} from "react";

export default function PluginCard({title,description,status,branding,bannerClassName="bg-accent/10",onClick}:{title:string;description:string;status:ReactNode;branding:ReactNode;bannerClassName?:string;onClick:()=>void}){
 return <button type="button" onClick={onClick} className="group flex h-full w-full min-w-0 flex-col rounded-xl text-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
  <div aria-hidden="true" className={`flex aspect-[16/9] w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border px-6 transition-transform group-hover:scale-[1.02] ${bannerClassName}`}>{branding}</div>
  <div className="flex w-full flex-1 flex-col px-2 pb-3 pt-3"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-2 flex-1 text-sm text-muted">{description}</p><div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-muted">{status}</div></div>
 </button>;
}
