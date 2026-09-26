import { UsersRound } from "lucide-react";
import { Switch } from "./ui";
import { languageName } from "../lib/credits";
import { systemCastLanguage, useCastPreferences } from "../lib/castPreferences";

export default function CastPreferences() {
  const { value, language, save, busy, error } = useCastPreferences();
  const name = languageName(language);
  const options = [["both", `Primary + ${name} Cast`, `Original performances and ${name} cast.`], ["original", "Primary Cast Only", "Original-language performances."], ["dub", `${name} Cast Only`, `${name}-language performances.`]] as const;
  const languages = [...new Set(["en", "ja", "es", "fr", "de", "it", "pt", "ko", "zh", "ar", "hi", "ru", "nl", "pl", "tr", "th", "vi", "id", "uk", systemCastLanguage(), ...(value.language === "system" ? [] : [value.language])])].sort((a,b) => languageName(a).localeCompare(languageName(b)));
  return <section aria-label="Cast & Crew preferences">
    <h3 className="mb-5 flex items-center gap-2 font-semibold"><UsersRound className="size-4 text-accent" />Cast & Crew</h3>
    <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
      <div><div className="flex items-center justify-between gap-3"><span className="text-sm">Show Cast & Crew</span><Switch label="Show Cast & Crew" checked={value.show} onChange={() => save({ show: !value.show })} /></div><p className="mt-1 text-xs text-faint">Display credits on series pages.</p></div>
      {value.show && <>
        <div><div className="flex items-center justify-between gap-3"><span className="text-sm">Hide Crew</span><Switch label="Hide Crew" checked={value.hide_crew} onChange={() => save({ hide_crew: !value.hide_crew })} /></div><p className="mt-1 text-xs text-faint">Show actors and voice actors without crew.</p></div>
        <fieldset><legend className="mb-2 text-sm font-medium">Cast Display</legend><div className="space-y-2">{options.map(([mode, label, description]) => <label key={mode} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${value.mode === mode ? "border-accent/40 bg-accent/10" : "border-border bg-surface-2/40 hover:bg-surface-2"}`}><input type="radio" name="cast-display" value={mode} checked={value.mode === mode} onChange={() => save({ mode })} className="mt-1 accent-accent" /><span><span className="block text-sm">{label}</span><span className="mt-1 block text-xs text-muted">{description}</span></span></label>)}</div></fieldset>
        <label className="block text-sm font-medium">Cast Language<select value={value.language} onChange={event => save({ language: event.target.value })} className="mt-2 w-full rounded-lg border border-border bg-input p-3 text-sm text-white"><option value="system">System Default — {languageName(systemCastLanguage())}</option>{languages.map(code => <option key={code} value={code}>{languageName(code)}</option>)}</select></label>
      </>}
    </fieldset>
    <p className="mt-4 text-xs text-faint">Changes save automatically for your account across TV and anime libraries. All saved credits are kept. System Default follows this device’s browser language.</p>
    {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
  </section>;
}
