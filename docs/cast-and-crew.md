# Movie and series cast and crew

Open a movie or TV/anime series and find **Cast & Crew** near the bottom of the page, below Seasons for series. Credits are stored in PosterView and remain available without re-fetching a provider on every page visit.

## Import credits

Use **Find Missing Metadata** in the title’s ⋯ or right-click menu to add missing credits from linked providers. For manual series searches and source management:

1. Open **Edit Metadata → Provider matching & imported metadata**.
2. Select AniList, MyAnimeList via Jikan, TheTVDB, or TMDb.
3. Search and choose **Import** on the correct series. Review the title/year; anime seasons and remakes can have separate records. If the media server already supplies a matching provider ID, an import shortcut is available.
4. Add another provider or additional season entries to fill gaps. Importing a different record does not replace an earlier season. Refresh updates only that specific provider record; Remove removes only its saved credits.

AniList and Jikan need no API credentials. TheTVDB uses the existing key/PIN in Settings. Add a **TMDb API Read Access Token** under **Edit Metadata → Provider matching & imported metadata → Provider connections & attribution**. The token is encrypted with PosterView's existing secret-storage mechanism and never returned to the browser.

MyAnimeList's documented official API v2 does not expose anime characters, voice performances or staff. This credits feature uses the unofficial Jikan interface to public MyAnimeList pages, visibly identified as **MyAnimeList via Jikan**. It is optional: select it only when importing that source. AniList operates directly and independently. The official MAL API remains appropriate for future general metadata integration.

## Choose what to display

- Open **⋯ Preferences** beside the search bar in a movie or TV/anime library. **Cast & Crew** contains **Show Cast & Crew**, **Hide Crew**, three cast-display choices, and **Cast Language**.
- **Primary + selected language** is the initial mode. Choose **Primary Cast Only** or **Selected-language Cast Only** as needed. The labels display the resolved language name.
- **System Default** uses the current browser's preferred language. Select an explicit language to use the same language on every device.
- All available language-tagged credits are captured during import. Changing the view never deletes another cast language.
- Preferences are saved on PosterView per authenticated username across devices and movie/TV libraries. Existing browser-only cast preferences are superseded by the new account defaults. This does not introduce new accounts or change authentication.
- Set **Title’s original language** when the providers do not identify it, including AniList-only imports. This series metadata is saved in the database. An actor's language, a title's production country, and the language used to translate a provider response are not reliable substitutes for the series' original language.
- Credits without a confirmed performance language remain saved but are excluded from cast language tabs. They are not assigned an assumed original or dubbed language.
- AniList's dub-group labels and role notes are retained. Multiple recordings in the same language remain separate. Where a provider does not supply this distinction, PosterView cannot reconstruct it.
- Crew has its own tab unless **Hide Crew** is enabled. Sources can be viewed together or by provider. The title-specific original-language correction is under **Edit Metadata → Provider matching & imported metadata**.

Cards show the performer, character/job, portrait where available, dub notes and provider links. Equivalent displayed labels may be coalesced across sources; provider-scoped person identities and original credit records remain separate in storage. Differently named credits remain separate rather than being automatically identified as the same person.

## Storage and refresh behavior

The additive tables in `posterview.db` are:

- `credit_series`: stable local ID, `(server_id, item_id)` mapping, optional original-language override.
- `credit_sources`: `(series_id, provider, external_id)` identity, matched title, source URL, provider language and fetch timestamp.
- `series_credits`: provider-scoped people/character identifiers, names/portraits/links, category/job, performance language, dub group, notes and order. Its composite FK cascades when the specific source is removed.

This is an incremental feature, not the full proposed shared catalog. Series mappings are currently scoped to a media-server item; automatic cross-server matching is deferred. Deleting a media-server connection also removes its saved series credits.

Imports page through AniList cast and staff, apply request pacing, and replace a source transactionally only after a successful complete fetch. Explicit size/pagination limits fail rather than silently truncate the catalog. Provider errors retain existing credits. Find Missing Metadata merges absent credit rows without replacing existing rows and also supports movies. Built-in scheduled tasks support background fetching; see [Scheduled Tasks](scheduled-tasks.md). Hand-edited credits, cast NFO export and server metadata publishing remain outside this feature.

## Verification

Tests cover original/dub filtering, missing language handling, alternate dub groups, separate staff jobs, provider matching, failed-refresh retention, durable SQL storage, source isolation, authenticated routes and encrypted credentials. An opt-in live test checks Japanese/English cast and crew via AniList and Jikan. Live service errors can fail that test independently of fixture tests; TMDb/TheTVDB live checks need configured credentials.

## References

- [AniList character edges](https://docs.anilist.co/reference/object/characteredge) and [voice-role model](https://docs.anilist.co/reference/object/staffroletype)
- [Official MyAnimeList API reference](https://myanimelist.net/apiconfig/references/api/v2)
- [Jikan API](https://docs.api.jikan.moe/)
- [TMDb aggregate series credits](https://developer.themoviedb.org/reference/tv-series-aggregate-credits)
- [TheTVDB v4 schema](https://github.com/thetvdb/v4-api/blob/master/docs/swagger.yml)

## Cast carousel and characters

The display uses a single horizontal portrait row with tabs for the selected cast languages, Crew (unless hidden in preferences), and Characters. Use the mouse wheel over the row, touch scrolling, the side arrows, or keyboard arrows. At either end, wheel input returns to normal page scrolling. Language tabs follow the saved primary/selected-language preferences; untagged performances do not create an additional cast tab.

Characters are grouped by displayed name within the selected title/source filter. Open a character to see its saved biography and performers by language. Biographies may contain spoilers and are collapsed initially. AniList descriptions are captured with cast imports and stored in PosterView; run Find Missing Metadata or refresh the AniList credit source to populate existing entries. The fill-only task fills an absent biography without replacing one already saved. Other providers still contribute their available character names, images, and performer relationships. A missing biography is explicitly identified rather than invented.

### Jikan recovery

Jikan searches, metadata, and credits share serialized requests spaced at least 1.1 seconds apart. Timeouts, connection failures, and HTTP 408/429/500/502/503/504 receive up to three attempts with increasing delays. Numeric Retry-After headers are respected; long waits and exhausted retries open a cooldown of at least 60 seconds. Other providers continue, and saved metadata is preserved. Find Missing Metadata reports temporary Jikan outages in its issues list without counting those alone as failed titles. Rerun the task after the cooldown, or let its next configured schedule retry; no separate retry task is created.

### AniDB metadata fetcher

Enable AniDB under Settings → Search Providers using your registered HTTP API client name and numeric version, then save and test the connection. No AniDB account password is stored. The documented public HTTP endpoint receives only the client registration details and anime ID.

AniDB uses confirmed IDs from the media server or Edit Metadata → Provider matching. Find Missing Metadata (including its existing all-library scheduled task) fills empty descriptions, original titles, dates, tags, studios, directors, and original-work credits. It preserves existing fields, records AniDB provenance, rejects movie/series mismatches and mismatched response IDs, and excludes explicitly marked spoiler tags. It does not auto-match titles, import language-specific cast, or write fetched data to NFOs automatically.

Responses are cached on disk for 30 days (128 MB cap). Requests are serialized with six seconds between requests; provider errors cause a 30-minute cooldown. The test button validates a known anime record using saved settings. Real access requires a client registered with AniDB; no bundled or borrowed client identity is used.

Fetch Missing Cast & Crew and Refresh Cast & Crew scan both movie and TV libraries. Movie credits use movie-specific provider endpoints. A task already in progress retains its saved inventory; start a fresh run after updating to include movies.

Character biographies display in full immediately when a character profile is opened, without a disclosure or spoiler label.
