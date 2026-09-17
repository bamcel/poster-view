import { useEffect, type KeyboardEvent, type RefObject } from "react";

export function useActionMenu(open: boolean, close: () => void, trigger: RefObject<HTMLButtonElement | null>, menu: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (open) (menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu.current)?.focus();
  }, [open, menu]);

  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      close();
      trigger.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  };
}
