import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { initializeTheme } from "./lib/theme";
import "./index.css";

initializeTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 30 * 60_000, retry: 1, refetchOnWindowFocus: false },
  },
});

// Refresh the watch controls when a player report finishes, including exit reports.
window.addEventListener("posterview-watch-updated", () => {
  for (const key of ["watch-history", "continue-watching", "watch-state", "watch-library-states"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
