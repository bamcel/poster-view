import {PlaybackNavigationProvider} from "./lib/playbackNavigation";
import {ActivityProvider} from "./features/activity/ActivityContext";
import ActivitySources from "./features/activity/ActivitySources";
import HomePage from "./pages/HomePage";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import { ToastProvider } from "./lib/toast";
import AuthGate from "./components/AuthGate";
import { ServerProvider } from "./lib/serverContext";
import AppearanceBootstrap from "./components/AppearanceBootstrap";
import { lazy, Suspense } from "react";
const WatchHistoryPage = lazy(() => import("./pages/WatchHistoryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ItemDetailPage = lazy(() => import("./pages/ItemDetailPage"));
const SeasonDetailPage = lazy(() => import("./pages/SeasonDetailPage"));
const PlayerPage = lazy(() => import("./features/playback/PlayerPage"));
const VirtualTvPage = lazy(() => import("./features/virtual-tv/VirtualTvPage"));
const CollectionsPage = lazy(() => import("./features/collections/CollectionsPage"));
const PairwisePage = lazy(() => import("./features/pairwise/PairwisePage"));
const CollectionPage = lazy(() => import("./features/collections/CollectionPage"));
const VirtualTvPlayer = lazy(() => import("./features/virtual-tv/VirtualTvPlayer"));
const ReaderPage = lazy(() => import("./pages/ReaderPage"));

export default function App() {
  return (
    <AuthGate>
      <AppearanceBootstrap>
        <ServerProvider>
          <ToastProvider>
            <ActivityProvider><ActivitySources/>
            <PlaybackNavigationProvider><Routes>
            <Route path="/play/virtual-tv/:channelId" element={<Suspense fallback={<p className="p-8">Tuning in…</p>}><VirtualTvPlayer /></Suspense>} />
            <Route path="/play/native/:libraryId/:itemId" element={<Suspense fallback={<p className="p-8">Opening player…</p>}><PlayerPage /></Suspense>} />
            <Route path="/read/native/:libraryId/:itemId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route path="/read/:serverId/:itemId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route path="/reader/:bookId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route element={<Layout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/collections" element={<Suspense fallback={<p role="status" className="p-8">Loading collections…</p>}><CollectionsPage /></Suspense>} />
              <Route path="/rankings" element={<Suspense fallback={<p role="status" className="p-8">Loading rankings…</p>}><PairwisePage /></Suspense>} />
              <Route path="/collections/:id" element={<Suspense fallback={<p role="status" className="p-8">Loading collection…</p>}><CollectionPage /></Suspense>} />
              <Route path="/virtual-tv" element={<Suspense fallback={<p className="p-8">Loading guide…</p>}><VirtualTvPage /></Suspense>} />
              <Route path="/media/:libraryId" element={<DashboardPage />} />
              <Route path="/media/:libraryId/:itemSlug" element={<DashboardPage />} />
              <Route path="/media/:libraryId/:itemSlug/:seasonSlug/:episodeSlug" element={<DashboardPage />} />
              <Route path="/media/:libraryId/:itemSlug/:seasonSlug" element={<DashboardPage />} />
              <Route path="/server/:serverId/series/:seriesId/season/:seasonId" element={<Suspense fallback={<p role="status" className="p-8">Loading page…</p>}><SeasonDetailPage /></Suspense>} />
              <Route path="/history" element={<Suspense fallback={<p className="p-8">Loading history…</p>}><WatchHistoryPage /></Suspense>} />
              <Route path="/settings/*" element={<Suspense fallback={<p role="status" className="p-8">Loading page…</p>}><SettingsPage /></Suspense>} />
              <Route path="/server/:serverId/item/:itemId" element={<Suspense fallback={<p role="status" className="p-8">Loading page…</p>}><ItemDetailPage /></Suspense>} />
            </Route>
            </Routes></PlaybackNavigationProvider>
            </ActivityProvider>
          </ToastProvider>
        </ServerProvider>
      </AppearanceBootstrap>
    </AuthGate>
  );
}
