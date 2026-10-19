import { useQueryClient } from "@tanstack/react-query";
import { invalidateArtworkItems } from "../../lib/artworkTarget";
import { useToast } from "../../lib/toast";
import type { ImageTarget } from "../../types";

/** Common save feedback; request payloads and busy state stay with each tool. */
export function useArtworkMutationFeedback(serverId: number, itemId: string) {
  const client = useQueryClient();
  const toast = useToast();
  const refresh = async (targetId = itemId, target?: ImageTarget) => {
    await Promise.all([
      invalidateArtworkItems(client, serverId, targetId, target),
      client.invalidateQueries({ queryKey: ["item-detail", serverId, itemId] }),
    ]);
  };
  const complete = async (result: { ok: boolean; message: string }, targetId = itemId, target?: ImageTarget) => {
    toast.push(result.ok ? "success" : "error", result.message);
    if (result.ok) await refresh(targetId, target);
  };
  const fail = (error: unknown) => toast.push("error", (error as Error).message);
  return { refresh, complete, fail };
}
