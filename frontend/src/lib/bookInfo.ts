import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { readerRequest } from "./reader";

export interface BookInfo { title?: string; sort_title?: string; status?: "Reading" | "Finished" }
export function bookTitleOrder(a: { id: string; title: string }, b: { id: string; title: string }, info: Record<string, BookInfo>) {
  return (info[a.id]?.sort_title || a.title).localeCompare(info[b.id]?.sort_title || b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id);
}
export function useBookInfo(server: number | null, items: { id: string }[] | undefined, enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey: ["book-info"] }); };
    window.addEventListener("posterview:reading-progress", refresh);
    return () => window.removeEventListener("posterview:reading-progress", refresh);
  }, [client]);
  const ids = items?.map(item => item.id) ?? [];
  return useQuery({
    queryKey: ["book-info", server, ids], enabled: enabled && !!server && ids.length > 0,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const result: Record<string, BookInfo> = {};
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (next < ids.length && !signal.aborted) {
          const id = ids[next++];
          try { result[id] = await readerRequest<BookInfo>(`/api/reader/info/${server}/${encodeURIComponent(id)}`, { signal }); }
          catch { /* Unmounted books keep their server title and remain browsable. */ }
        }
      }));
      return result;
    },
  });
}
