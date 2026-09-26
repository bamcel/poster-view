# IMDb database source

Open **Settings → Database → IMDb** and enable the source. Then choose **Download IMDb Data**. Each installation downloads its own copy directly from IMDb; PosterView does not bundle the datasets. The source is disabled by default and enabling it alone does not download anything.

Follow progress or cancel under **Settings → Scheduled Tasks → Refresh IMDb Data**. This built-in task can also run on a recurring schedule (weekly by default when enabled). It refreshes the shared local source for every library; it does not require a media server connection. A full refresh downloads the title basics and ratings datasets and builds a new local SQLite index. Allow several GB of available disk space, including the previous index and temporary files during a refresh. A restart retries the refresh from the beginning.

Supported fields: IMDb ID, title type, primary/original title, start/end year, runtime, genres, IMDb rating, and vote count. Cast, crew, plot summaries, artwork, and episode-parent relationships are not included in this first integration.

After download, search by exact IMDb ID or title prefix in Database settings. Movie and series detail pages with an existing IMDb ID show an IMDb metadata section. Ratings remain explicitly labeled IMDb; the integration does not overwrite server metadata, your NFO files, or cast sources. Titles without an IMDb ID are not automatically matched.

Downloads are streamed to temporary files, then validated and imported off the async worker. A new snapshot is activated only after both datasets are imported successfully. Failed or cancelled imports preserve the previous snapshot. Cancellation is checked during downloading and row import; SQLite indexing may need to finish before cancellation completes. Disabling the source stops its schedule, requests cancellation of an active refresh, and hides lookups while retaining the local index.

The data is subject to [IMDb's dataset terms](https://developer.imdb.com/non-commercial-datasets/) and [software-use conditions](https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX). This source is intended for the user's personal, noncommercial installation.

Information courtesy of [IMDb](https://www.imdb.com). Used with permission.
