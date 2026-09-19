import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import LibraryPage from "./pages/LibraryPage";
import ItemDetailPage from "./pages/ItemDetailPage";
import SettingsPage from "./pages/SettingsPage";
import HistoryPage from "./pages/HistoryPage";
import { ToastProvider } from "./lib/toast";
import AuthGate from "./components/AuthGate";
import { ServerProvider } from "./lib/serverContext";

export default function App() {
  return (
    <AuthGate>
      <ServerProvider>
        <ToastProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<LibraryPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/server/:serverId/item/:itemId" element={<ItemDetailPage />} />
            </Route>
          </Routes>
        </ToastProvider>
      </ServerProvider>
    </AuthGate>
  );
}
