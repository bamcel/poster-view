import {useEffect, useId, useRef, useState, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {Info, X} from "lucide-react";
import {mediaDescription} from "../lib/mediaDescription";
import "./CharacterHoverCard.css";

const openedEvent = "posterview:character-preview-open";
export default function CharacterHoverCard({person, children, portrait}: {person: Record<string, unknown>; children: ReactNode; portrait: ReactNode}) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dismissed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{left: number; top: number; width: number} | null>(null);
  const name = typeof person.name === "string" && person.name.trim() ? person.name.trim() : "Character";
  const role = typeof person.role === "string" ? person.role.trim() : "";
  const biography = mediaDescription(String(person.biography ?? person.description ?? "").replace(/~![\s\S]*?(?:!~|$)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1")).split("\n").filter(line => !/^[\t ]*_{2,}.+?_{2,}/.test(line)).join("\n").trim();
  function cancel() {clearTimeout(timer.current); timer.current = undefined;}
  function close() {cancel(); setPosition(null);}
  function open() {
    cancel();
    if (dismissed.current || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const width = Math.min(360, Math.max(1, window.innerWidth - 24));
    window.dispatchEvent(new CustomEvent(openedEvent, {detail: id}));
    setPosition({width, left: Math.max(12, Math.min(rect.left - (width - rect.width) / 2, window.innerWidth - width - 12)), top: Math.max(12, Math.min(rect.top - 16, window.innerHeight - Math.min(380, window.innerHeight - 24) - 12))});
  }
  function leave() {cancel(); timer.current = setTimeout(close, 180);}
  function blur(target: EventTarget | null) {
    if (target instanceof Node && (anchor.current?.contains(target) || panel.current?.contains(target))) return;
    dismissed.current = false;
    leave();
  }
  function dismiss() {dismissed.current = true; close(); opener.current?.focus();}
  useEffect(() => {
    const another = (event: Event) => {if ((event as CustomEvent<string>).detail !== id) close();};
    window.addEventListener(openedEvent, another);
    return () => {clearTimeout(timer.current); window.removeEventListener(openedEvent, another);};
  }, [id]);
  useEffect(() => {
    if (!position) return;
    const escape = (event: KeyboardEvent) => {if (event.key === "Escape") {event.preventDefault(); dismiss();}};
    const scroll = (event: Event) => {if (!(event.target instanceof Node && panel.current?.contains(event.target))) close();};
    const outside = (event: PointerEvent) => {if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();};
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", outside);
    return () => {window.removeEventListener("keydown", escape); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); document.removeEventListener("pointerdown", outside);};
  }, [position]);
  return <div ref={anchor} className="pv-character-anchor w-48 shrink-0 rounded-xl p-4" onMouseEnter={() => {dismissed.current = false; cancel(); timer.current = setTimeout(open, 350);}} onMouseLeave={leave} onFocus={event => {if (anchor.current?.contains(event.target)) {opener.current = event.target; open();}}} onBlur={event => blur(event.relatedTarget)}>
    {children}
    <button type="button" className="pv-character-trigger" aria-label={`Preview ${name}`} aria-expanded={!!position} aria-controls={position ? id : undefined} onClick={event => {opener.current = event.currentTarget; dismissed.current = false; open();}} onKeyDown={event => {if (position && event.key === "Tab" && !event.shiftKey) {event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>("button")?.focus();}}}><Info size={17} aria-hidden="true"/></button>
    {position && createPortal(<div ref={panel} id={id} role="region" aria-label={`Profile of ${name}`} className="pv-character-panel pv-popup-surface" style={{...position, maxHeight: `min(420px, calc(100dvh - ${position.top + 12}px))`}} onMouseEnter={cancel} onMouseLeave={leave} onFocus={cancel} onBlur={event => blur(event.relatedTarget)}>
      <button type="button" className="pv-character-dismiss" aria-label={`Close profile of ${name}`} onClick={dismiss}><X size={18} aria-hidden="true"/></button>
      <div className="pv-character-art"><div className="pv-character-art-tint" aria-hidden="true">{portrait}</div><div className="pv-character-portrait">{portrait}</div></div>
      <div className="pv-character-body"><div className="pv-character-heading"><span className="pv-character-eyebrow">Character</span><h3>{name}</h3>{role && <p className="pv-character-role">{role.replace(/_/g, " ").toLowerCase()}</p>}</div>
      {biography ? <p className="pv-character-biography">{biography}</p> : <p className="pv-character-empty">No character biography available.</p>}</div>
    </div>, document.body)}
  </div>;
}
