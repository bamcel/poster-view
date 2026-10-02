import {useEffect, useRef, useState, type ReactNode} from "react";
import {ChevronLeft, ChevronRight} from "lucide-react";

export default function PeopleRow({label, children}: {label: string; children: ReactNode}) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({left: false, right: false});
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const update = () => setEdges({left: element.scrollLeft > 1, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1});
    update();
    element.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : undefined;
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {element.removeEventListener("scroll", update); window.removeEventListener("resize", update); observer?.disconnect();};
  }, [children]);
  const scroll = (direction: number) => row.current?.scrollBy({left: direction * Math.max(150, row.current.clientWidth * 0.8), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
  return <div className="group/people relative">
    <div ref={row} className="scrollbar-hidden flex gap-4 overflow-x-auto pb-3">{children}</div>
    {edges.left && <button type="button" aria-label={`Scroll ${label} left`} onClick={() => scroll(-1)} className="absolute left-0 top-24 z-10 grid size-[60px] place-items-center rounded-full border border-white/15 bg-black/20 text-white/70 opacity-0 pointer-events-none backdrop-blur transition-opacity group-hover/people:opacity-100 group-hover/people:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:bg-black/35 hover:text-white"><ChevronLeft className="size-[30px]"/></button>}
    {edges.right && <button type="button" aria-label={`Scroll ${label} right`} onClick={() => scroll(1)} className="absolute right-0 top-24 z-10 grid size-[60px] place-items-center rounded-full border border-white/15 bg-black/20 text-white/70 opacity-0 pointer-events-none backdrop-blur transition-opacity group-hover/people:opacity-100 group-hover/people:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:bg-black/35 hover:text-white"><ChevronRight className="size-[30px]"/></button>}
  </div>;
}
