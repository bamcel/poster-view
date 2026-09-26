import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import ItemDetailPage from "./pages/ItemDetailPage";
import SettingsPage from "./pages/SettingsPage";
import HistoryPage from "./pages/HistoryPage";
import { ToastProvider } from "./lib/toast";
import AuthGate from "./components/AuthGate";
import { ServerProvider } from "./lib/serverContext";
import AppearanceBootstrap from "./components/AppearanceBootstrap";
import { lazy, Suspense } from "react";
const ReaderPage = lazy(() => import("./pages/ReaderPage"));

export default function App() {
  return (
    <AuthGate>
      <AppearanceBootstrap>
        <ServerProvider>
          <ToastProvider>
            <Routes>
            <Route path="/read/:serverId/:itemId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route path="/reader/:bookId" element={<Suspense fallback={<p className="p-8">Opening reader…</p>}><ReaderPage /></Suspense>} />
            <Route element={<Layout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/server/:serverId/item/:itemId" element={<ItemDetailPage />} />
            </Route>
            </Routes>
          </ToastProvider>
        </ServerProvider>
      </AppearanceBootstrap>
    </AuthGate>
  );
}
