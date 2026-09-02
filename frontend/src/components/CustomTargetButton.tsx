// A small "Custom" button + popover letting you override where an image gets
// applied — e.g. using a poster image as a Season 0 (Specials) poster instead
// of its auto-detected placement. Lists every target: Poster, Background,
// Logo, and each season. Appears next to the normal Poster/Season/Background
// button.
//
// The popover is rendered into a portal at the document root, positioned from
// the button's actual screen location. It can't just be an absolutely-positioned
// child here: the panel that hosts these cards scrolls (overflow-y-auto), which
// per the CSS overflow spec forces the other axis to clip too — so a popover
// anchored inside it gets cut off sideways instead of overlapping neighboring
// cards. Escaping to a portal sidesteps that entirely.

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2, Loader2, ChevronDown } from "lucide-react";
import { buildApplyTargets } from "../lib/targets";
import type { ImageTarget, ItemDetail } from "../types";

const MENU_WIDTH = 192; // matches w-48

export default function CustomTargetButton({
  item,
  busy,
  onPick,
  className = "",
}: {
  item: ItemDetail;
  busy?: boolean;
  onPick: (target: ImageTarget, itemId: string, label: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const targets = buildApplyTargets(item);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Right-align to the button, but clamp so it always stays on-screen.
      const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={busy}
        className={`flex min-w-0 items-center gap-1 rounded bg-elevated px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:text-white disabled:opacity-60 ${className}`}
        title="Choose exactly where to apply this image"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Settings2 className="size-3" />}
        Custom
        <ChevronDown className="size-3" />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            {/* Transparent backdrop closes the popover on an outside click. */}
            <button
              aria-hidden
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div
              style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
              className="fixed z-50 max-h-56 overflow-y-auto rounded-lg border border-border bg-elevated py-1 shadow-xl"
            >
              {targets.map((t, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setOpen(false);
                    onPick(t.target, t.itemId, t.label);
                  }}
                  className="block w-full truncate px-3 py-1.5 text-left text-xs text-muted hover:bg-surface-2 hover:text-white"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
