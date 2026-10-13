import type { ReactNode } from "react";
import { useIsAdmin } from "../lib/authContext";

export default function AdminOnly({ children }: { children: ReactNode }) {
  return useIsAdmin() ? children : null;
}
