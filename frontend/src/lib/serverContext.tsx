// Tracks which media server is "active" across the app. The selection persists
// to localStorage and defaults to the user's default server (or the first one).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Server } from "../types";

interface ServerContextValue {
  servers: Server[];
  isLoading: boolean;
  selectedId: number | null;
  setSelectedId: (id: number) => void;
  selectedServer: Server | null;
}

const ServerContext = createContext<ServerContextValue | null>(null);
const STORAGE_KEY = "posterview.activeServer";

export function ServerProvider({ children }: { children: ReactNode }) {
  const { data: servers = [], isLoading } = useQuery({
    queryKey: ["servers"],
    queryFn: api.listServers,
  });

  const [selectedId, setSelectedIdState] = useState<number | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) : null;
  });

  // Keep the selection valid as servers load or change.
  useEffect(() => {
    if (servers.length === 0) return;
    const stillExists = selectedId != null && servers.some((s) => s.id === selectedId);
    if (!stillExists) {
      const fallback = servers.find((s) => s.is_default) ?? servers[0];
      setSelectedIdState(fallback.id);
    }
  }, [servers, selectedId]);

  const setSelectedId = (id: number) => {
    setSelectedIdState(id);
    localStorage.setItem(STORAGE_KEY, String(id));
  };

  const value = useMemo<ServerContextValue>(
    () => ({
      servers,
      isLoading,
      selectedId,
      setSelectedId,
      selectedServer: servers.find((s) => s.id === selectedId) ?? null,
    }),
    [servers, isLoading, selectedId],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServers(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServers must be used within ServerProvider");
  return ctx;
}
