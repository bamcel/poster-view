import { useState } from "react";

const editions = ["Standard", "Original", "Colored"];
export default function EditionField({ value, onChange, inputClass }: { value: string; onChange: (value: string) => void; inputClass: string }) {
  const preset = editions.find(edition => edition.toLowerCase() === value.trim().toLowerCase());
  const [custom, setCustom] = useState(Boolean(value && !preset));
  return <div className="text-sm text-muted">
    <label>Edition<select className={inputClass} value={custom ? "custom" : preset ?? ""} onChange={event => {
      const next = event.target.value;
      setCustom(next === "custom");
      if (next !== "custom") onChange(next);
      else if (preset) onChange("");
    }}>
      <option value="">Not Set</option>
      {editions.map(edition => <option key={edition}>{edition}</option>)}
      <option value="custom">Custom</option>
    </select></label>
    {custom && <label className="mt-2 block">Custom Edition<input className={inputClass} value={value} onChange={event => onChange(event.target.value)} /></label>}
  </div>;
}
