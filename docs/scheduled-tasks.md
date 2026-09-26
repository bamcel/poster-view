# Scheduled Tasks

Open **Settings -> Scheduled Tasks**. The list contains built-in tasks, each with a description, last-run information, and a circular Run button:

- **Fetch Missing Cast & Crew** fills absent or empty provider credit sources.
- **Refresh Outdated Cast & Crew** refreshes old sources and fills missing ones.
- **Find Missing Metadata** fills missing fields and credits across all movie and TV libraries, using the same action as the title menu. See [Find Missing Metadata](find-missing-metadata.md).
- **Refresh IMDb Data** downloads and indexes the optional local IMDb title/rating source. Enable it under **Settings → Database** first; see [IMDb](imdb.md).

Find Missing Metadata discovers every movie and TV library across all connected servers on each run. The two dedicated Cast & Crew tasks discover TV libraries only. New libraries are included automatically; no library selection is required. Book libraries are excluded.

Use the Run button to start immediately; it becomes Cancel during a run. Expand **Schedule & details** to enable recurrence, change the interval or refresh age, and review issues and recent runs. Schedules start disabled. The first scheduled run starts after the saved interval. PosterView's server must be running; overdue schedules run at startup.

Tasks use saved provider matches or linked IDs. AniList and MyAnimeList (via Jikan) are available automatically; TVDB and TMDB are used when their credentials are configured. A title needs matching if it has no usable linked source. Open its issue link and use **Edit Metadata → Provider matching**, then rerun. All available languages are stored; Cast & Crew display preferences apply separately.

Runs execute sequentially with bounded provider retries and progress saved after each title. A restart resumes the checkpoint; an interrupted title may be fetched again. Cancellation takes effect between provider requests. Previously saved credits remain. A scan failure stops the run instead of silently skipping libraries; individual title failures are reported and processing continues.

Details show the first 200 issues and five recent runs. Built-in tasks cannot be renamed or deleted. Schedules are shared server configuration for authenticated users.

Upgrading from custom tasks leaves the old task settings and history stored under the original database key for recovery, but those custom schedules no longer execute. Set the new built-in schedules as desired; fetched credits are unchanged.

NFO publishing and pushing metadata to other servers remain follow-up task types.
