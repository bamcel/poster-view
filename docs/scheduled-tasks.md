# Scheduled Tasks

Open **Settings → Scheduled Tasks → New Task**. Choose a media server, TV libraries, and credit providers, then save. **Run Now** starts immediately; enable the recurring schedule to run after the chosen interval. PosterView's server must be running. Overdue schedules run when it starts again.

- **Fetch missing cast & crew** fills absent or empty provider credit sources.
- **Refresh outdated cast & crew** refreshes sources older than the selected number of days and fills missing sources.

Tasks use saved provider matches or linked IDs from your media server. They do not guess matches from titles. Open titles in **Needs matching & run issues**, use **Sources & matching** to choose the correct provider title, and rerun. TMDB and TheTVDB require configured credentials. MyAnimeList credits currently use Jikan.

All available languages are stored. The Cast & Crew preferences control which languages are displayed, independently of these tasks.

Runs execute sequentially with bounded provider retries and progress saved after each series. A restart resumes the current checkpoint; an interrupted series may be fetched again. Cancel stops before the next provider request/checkpoint; an in-flight request may finish first. Previously saved credits remain. Individual title failures are reported without stopping the collection. A scan failure stops the run rather than silently skipping a library.

Cards show progress, matching needs, failures, the first 200 issue details, and the last five completed runs. Edit a stopped task to change or disable its schedule. Delete removes the task configuration and inventory, not saved credits. Scheduled tasks are shared server configuration for authenticated users.

This initial release handles series cast and crew. General metadata enrichment, movie credits, NFO publishing, and pushing metadata to other media servers are follow-up task types.
