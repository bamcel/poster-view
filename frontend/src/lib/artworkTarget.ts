import type { QueryClient } from "@tanstack/react-query";

export function invalidateArtworkItems(client: QueryClient, serverId: number, itemId: string) {
  return client.invalidateQueries({queryKey:serverId === 0 && itemId.startsWith("native:")
    ? ["native-catalog", itemId.split(":")[1]] : ["items", serverId]});
}
