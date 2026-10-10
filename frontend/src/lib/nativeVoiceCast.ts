type Person = Record<string, unknown>;
const object = (value: unknown): Person => value && typeof value === "object" && !Array.isArray(value) ? value as Person : {};
const people = (value: unknown): Person[] => Array.isArray(value) ? value.map(object) : [];
export function voiceName(value: unknown) { return typeof value === "string" ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).sort().join(" ") : ""; }
export function orderedCharacters(value: unknown, images = new Map<string, string>()) {
  const hasImage = (person: Person) => Boolean(typeof person.image === "string" && person.image.trim() || images.get(voiceName(person.name)));
  const narrator = (person: Person) => /^(?:the\s+)?narrator$/i.test(String(person.name ?? "").trim());
  return people(value).slice().sort((a, b) => Number(!hasImage(a)) - Number(!hasImage(b)) || Number(narrator(a)) - Number(narrator(b)));
}
function language(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  try { return new Intl.DisplayNames(["en"], {type:"language"}).of(code); } catch { return value; }
}
function combine(cast: Person[]) {
  const actors = new Map<string, Person>();
  for (const person of cast) {
    const actorKey = person.provider_id != null ? `${person.provider ?? "anilist"}:${person.provider_id}` : voiceName(person.name);
    const key = `${actorKey}:${String(person.dub_group??"")}`;
    if (!actorKey) continue;
    const existing = actors.get(key);
    if (existing) {
      const roles = new Set(String(existing.role ?? "").split(" · ").filter(Boolean));
      if (person.role) roles.add(String(person.role));
      const notes=new Set([existing.role_notes,person.role_notes].filter(Boolean).map(String));
      existing.role_notes=[...notes].join(" · ");
      existing.role = [...roles].join(" · ");
      if (!existing.image && person.image) existing.image = person.image;
    } else actors.set(key, {...person});
  }
  return [...actors.values()];
}
export function animeVoiceGroups(metadata: Person, preferredCode: string, images = new Map<string, string>()) {
  const ani = object(metadata.anilist_data);
  let cast = people(metadata.voice_cast);
  if (!Array.isArray(metadata.voice_cast)) {
    cast = people(object(ani.characters).edges).flatMap(edge => people(edge.voiceActors).map(actor => ({
      name: object(actor.name).full, provider_id: actor.id, provider:"anilist", category:"voice", role:object(object(edge.node).name).full,
      image:object(actor.image).large, language:actor.languageV2 ?? (metadata.voice_cast_schema == null ? "Japanese" : undefined),
    })));
  }
  const country = String(metadata.country_of_origin ?? ani.countryOfOrigin ?? "").toUpperCase();
  const originCode = metadata.original_language ?? object(metadata.tmdb_data).original_language ?? ({JP:"ja",KR:"ko",CN:"zh",TW:"zh",US:"en",GB:"en"} as Record<string,string>)[country];
  const original = language(originCode);
  const preferred = language(preferredCode) ?? "English";
  const groups = [{title:original ? `${original} Cast` : "Original voice cast", cast:original ? combine(cast.filter(person => voiceName(person.language) === voiceName(original))) : [], empty:original ? `No ${original} voice cast available.` : "Original language has not been identified."}];
  if (voiceName(preferred) !== voiceName(original)) {
    const dubbed=cast.filter(person=>voiceName(person.language)===voiceName(preferred));
    const editions=[...new Set(dubbed.map(person=>String(person.dub_group??"").trim()))];
    if(editions.some(Boolean)) {
      for(const edition of editions) groups.push({title:`${preferred} Cast — ${edition||"Unspecified dub"}`,cast:combine(dubbed.filter(person=>String(person.dub_group??"").trim()===edition)),empty:`No ${preferred} voice cast available.`});
    } else groups.push({title:`${preferred} Cast`,cast:combine(dubbed),empty:`No ${preferred} voice cast available.`});
  }
  const characters = orderedCharacters(metadata.characters, images);
  const order = new Map<string, number>();
  characters.forEach((character, index) => {
    const name = voiceName(character.name);
    if (name && !order.has(name)) order.set(name, index);
  });
  const rank = (person: Person) => Math.min(...String(person.role ?? "").split(" · ").map(role => order.get(voiceName(role)) ?? Infinity));
  for (const group of groups) group.cast.sort((a, b) => {
    const left = rank(a), right = rank(b);
    return left === right ? 0 : left < right ? -1 : 1;
  });
  return {groups, names:new Set(groups.flatMap(group => group.cast).map(person => voiceName(person.name)).filter(Boolean))};
}
