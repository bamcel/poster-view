# Manga volume completeness

Open a manga **folder** in PosterView and use **Manga volume collection** below its metadata. This first version checks direct folder members, not the entire server, nested folders, chapters, or Western comic issues.

1. Keep one manga series and edition in the folder.
2. Search its title on AniList and explicitly select the correct match.
3. For a finished series with a known total, PosterView compares the numbered files with volumes 1 through that total.

**Complete** means every expected volume is represented. **Missing volumes** lists gaps. **Unknown** means the publication total/status or file numbering cannot safely establish completeness. Duplicate volume numbers count once. AniList metadata is cached in the browser for 24 hours; provider failures are displayed with a retry action.

Automatic detection accepts explicit title markers such as `Series Vol. 01`, `Series Volume 2`, or `Series v3`. The series prefix must match the folder title after punctuation/case normalization. Unnumbered items, mismatched prefixes, fractional volumes, omnibus editions, and ranges remain unresolved. This checks file numbering, not archive integrity or whether every page exists.

Expand **Edition and volume overrides** to supply an edition-specific expected total and confirm it is finished. Leave the total blank to use AniList. Enable manual owned volumes for ambiguous names or omnibus coverage; `1-3, 5, 7` means those original volumes are present. Only use the original-volume numbering when comparing an omnibus collection against an original-edition total.

Matches and overrides are scoped to the server and folder and stored in local browser storage. They do not yet sync across devices or browsers. Reset clears that folder's match and overrides. Ongoing titles remain Unknown until an appropriate finished-edition override is provided; this version does not claim that ongoing collections are up to date.

Metadata source: [AniList Media API](https://docs.anilist.co/reference/object/media), using `type: MANGA`, publication `status`, and `volumes`. Manga and one-shot formats are selectable; light novels are excluded from match choices. AniList totals may describe the original publication rather than a translated edition, so confirm the edition before relying on the result.
