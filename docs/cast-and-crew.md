# Series cast and crew

Open a TV/anime series and find **Cast & crew** above Seasons. Credits are stored in PosterView and remain available without re-fetching a provider on every page visit.

## Import credits

1. Open **Sources & matching**.
2. Select AniList, MyAnimeList via Jikan, TheTVDB, or TMDb.
3. Search and choose **Import** on the correct series. Review the title/year; anime seasons and remakes can have separate records. If the media server already supplies a matching provider ID, an import shortcut is available.
4. Add another provider or additional season entries to fill gaps. Importing a different record does not replace an earlier season. Refresh updates only that specific provider record; Remove removes only its saved credits.

AniList and Jikan need no API credentials. TheTVDB uses the existing key/PIN in Settings. Add a **TMDb API Read Access Token** under **Sources & matching → Provider connections & attribution**. The token is encrypted with PosterView's existing secret-storage mechanism and never returned to the browser.

MyAnimeList's documented official API v2 does not expose anime characters, voice performances or staff. This credits feature uses the unofficial Jikan interface to public MyAnimeList pages, visibly identified as **MyAnimeList via Jikan**. It is optional: select it only when importing that source. AniList operates directly and independently. The official MAL API remains appropriate for future general metadata integration.

## Choose what to display

- **Original + selected language** is the initial mode; English is the initial preferred dub.
- Choose **Original only**, **Selected language only**, or **All languages** as needed.
- All available language-tagged credits are captured during import. Changing the view never deletes another cast language.
- The display preference is stored per browser and signed-in username, not as a global server setting. PosterView's existing authentication model still applies; this does not introduce multi-user accounts or cross-device preference synchronization.
- Set **Series' original language** when the providers do not identify it, including AniList-only imports. This series metadata is saved in the database. An actor's language, a title's production country, and the language used to translate a provider response are not reliable substitutes for the series' original language.
- Credits without a confirmed performance language appear separately as **language unspecified**, not as an invented English dub. TMDb/TheTVDB credits generally belong here because their credit records do not identify the performance language.
- AniList's dub-group labels and role notes are retained. Multiple recordings in the same language remain separate. Where a provider does not supply this distinction, PosterView cannot reconstruct it.
- Crew has its own tab and is not hidden by the cast-language filter. Sources can be viewed together or by provider.

Cards show the performer, character/job, portrait where available, dub notes and provider links. Equivalent displayed labels may be coalesced across sources; provider-scoped person identities and original credit records remain separate in storage. Differently named credits remain separate rather than being automatically identified as the same person.

## Storage and refresh behavior

The additive tables in `posterview.db` are:

- `credit_series`: stable local ID, `(server_id, item_id)` mapping, optional original-language override.
- `credit_sources`: `(series_id, provider, external_id)` identity, matched title, source URL, provider language and fetch timestamp.
- `series_credits`: provider-scoped people/character identifiers, names/portraits/links, category/job, performance language, dub group, notes and order. Its composite FK cascades when the specific source is removed.

This is an incremental feature, not the full proposed shared catalog. Series mappings are currently scoped to a media-server item; automatic cross-server matching is deferred. Deleting a media-server connection also removes its saved series credits.

Imports page through AniList cast and staff, apply request pacing, and replace a source transactionally only after a successful complete fetch. Explicit size/pagination limits fail rather than silently truncate the catalog. Provider errors retain existing credits. Background imports, automatic cross-provider identity resolution, hand-edited credits, cast NFO export and server metadata publishing are outside this slice.

## Verification

Tests cover original/dub filtering, missing language handling, alternate dub groups, separate staff jobs, provider matching, failed-refresh retention, durable SQL storage, source isolation, authenticated routes and encrypted credentials. An opt-in live test checks Japanese/English cast and crew via AniList and Jikan. Live service errors can fail that test independently of fixture tests; TMDb/TheTVDB live checks need configured credentials.

## References

- [AniList character edges](https://docs.anilist.co/reference/object/characteredge) and [voice-role model](https://docs.anilist.co/reference/object/staffroletype)
- [Official MyAnimeList API reference](https://myanimelist.net/apiconfig/references/api/v2)
- [Jikan API](https://docs.api.jikan.moe/)
- [TMDb aggregate series credits](https://developer.themoviedb.org/reference/tv-series-aggregate-credits)
- [TheTVDB v4 schema](https://github.com/thetvdb/v4-api/blob/master/docs/swagger.yml)
