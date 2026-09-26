import { useState } from "react";

const editions = ["Standard", "Original", "Colored", "Special"];
export default function EditionField({ value, onChange, inputClass, remove = false, onRemove, emptyLabel = "Not Set" }: { value: string; onChange: (value: string) => void; inputClass: string; remove?: boolean; onRemove?: () => void; emptyLabel?: string }) {
  const preset = editions.find(edition => edition.toLowerCase() === value.trim().toLowerCase());
  const [custom, setCustom] = useState(Boolean(value && !preset));
  return <div className="text-sm text-muted">
    <label>Edition<select className={inputClass} value={remove ? "remove" : custom ? "custom" : preset ?? ""} onChange={event => {
      const next = event.target.value;
      setCustom(next === "custom");
      if (next === "remove") { onRemove?.(); return; }
      if (next !== "custom") onChange(next);
      else onChange(preset ? "" : value);
    }}>
      <option value="">{emptyLabel}</option>
      {editions.map(edition => <option key={edition}>{edition}</option>)}
      <option value="custom">Custom</option>
      {onRemove && <option value="remove">Remove Edition</option>}
    </select></label>
    {custom && !remove && <label className="mt-2 block">Custom Edition<input className={inputClass} value={value} onChange={event => onChange(event.target.value)} /></label>}
  </div>;
}
