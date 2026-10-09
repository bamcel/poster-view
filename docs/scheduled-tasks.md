# Scheduled Tasks

Settings → Scheduled Tasks replaces Database. The old `/settings/database` URL remains compatible. Connected-server cache controls are retained below the tasks.

Tasks are predefined and schedules are disabled by default. Each task supports Run now (Data Cleanup first offers Review cleanup), an interval of 1–365 days, saved configuration, and a last-run result. The scheduler checks once a minute while PosterView runs and catches up overdue enabled tasks after restart. Configuration and last-run results are stored in the application database. Tasks execute sequentially; failed runs are recorded and retry at the next interval.

- Data Cleanup: selected unused managed artwork, old local artwork mirrors, and abandoned temporary files, after the retention period (default 30 days). Managed artwork starts its grace period when cleanup first detects it as unreferenced; references becoming active again reset that grace period. Cache and temporary file age is based on modification time. Cleanup scans database text references, protecting missing-file artwork, editor originals/overlays, artwork backups, and animated stills. Active library scans defer cleanup. Media folders, reader bookmarks, and catalogs are never deleted. This first version does not remove obsolete placeholders, orphaned reader records, provider search caches, or sync notices.
- Trim History: remove apply-history records and their saved history backups older than retention (default 30 days).
- Optimize Database: SQLite quick health check, query-statistics optimization, passive WAL checkpoint. This does not run a blocking VACUUM.

Book Library Settings → Show missing files defaults on for existing and new libraries. Turning it off hides missing volume/chapter cards while preserving the missing count, catalog entries, and artwork. It does not mark covers unused or stop placeholder reconciliation.
