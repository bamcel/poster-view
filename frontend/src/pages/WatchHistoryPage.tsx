import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { watchApi } from "../features/playback/api/watch";
import SettingsPageFrame from "../components/SettingsPageFrame";

export default function WatchHistoryPage() {
  const history = useQuery({ queryKey: ["watch-history"], queryFn: watchApi.history });
  return (
    <SettingsPageFrame title="Watch history" description="Your viewing history and progress.">
      <div aria-live="polite">
        {history.isPending && <p>Loading history…</p>}
        {history.error && <p role="alert">{history.error.message}</p>}
        {history.data?.length === 0 && <p className="text-muted">Your history will appear after you start watching.</p>}
        <div className="divide-y divide-border">
          {history.data?.map(item => (
            <Link
              key={`${item.library_id}:${item.item_id}`}
              className="flex items-center justify-between gap-4 py-4 hover:text-accent"
              to={`/play/native/${encodeURIComponent(item.library_id)}/${encodeURIComponent(item.item_id)}?return=%2Fhistory`}
            >
              <div>
                <h2 className="font-medium">{item.title}</h2>
                <p className="text-sm text-muted">{item.library_name}</p>
              </div>
              <span className="text-sm text-muted">
                {item.state.watched ? "Watched" : `${Math.floor(item.state.position_seconds / 60)} min watched`}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </SettingsPageFrame>
  );
}
