import HomePage from "./pages/HomePage";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import { ToastProvider } from "./lib/toast";
import AuthGate from "./components/AuthGate";
import { ServerProvider } from "./lib/serverContext";
import AppearanceBootstrap from "./components/AppearanceBootstrap";
import { lazy, Suspense } from "react";
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ItemDetailPage = lazy(() => import("./pages/ItemDetailPage"));
const SeasonDetailPage = lazy(() => import("./pages/SeasonDetailPage"));
const ReaderPage = lazy(() => import("./pages/ReaderPage"));

export default function App() {
  return (
    <AuthGate>
      <AppearanceBootstrap>
        <ServerProvider>
          <ToastProvider>
            <Routes>
            <Route path="/read/native/:libraryId/:itemId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route path="/read/:serverId/:itemId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route path="/reader/:bookId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route element={<Layout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/media/:libraryId" element={<DashboardPage />} />
              <Route path="/media/:libraryId/:itemSlug" element={<DashboardPage />} />
              <Route path="/media/:libraryId/:itemSlug/:seasonSlug" element={<DashboardPage />} />
              <Route path="/server/:serverId/series/:seriesId/season/:seasonId" element={<Suspense fallback={<p role="status" className="p-8">Loading page…</p>}><SeasonDetailPage /></Suspense>} />
              <Route path="/history" element={<Navigate to="/" replace />} />
              <Route path="/settings/*" element={<Suspense fallback={<p role="status" className="p-8">Loading page…</p>}><SettingsPage /></Suspense>} />
              <Route path="/server/:serverId/item/:itemId" element={<Suspense fallback={<p role="status" className="p-8">Loading page…</p>}><ItemDetailPage /></Suspense>} />
            </Route>
            </Routes>
          </ToastProvider>
        </ServerProvider>
      </AppearanceBootstrap>
    </AuthGate>
  );
}
