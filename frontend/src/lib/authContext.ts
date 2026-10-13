import { createContext, useContext } from "react";
import type { AuthSession } from "../api/client";

// Share the gate's current policy without issuing another authentication request.
export const AuthSessionContext = createContext<AuthSession | null>(null);

export function useIsAdmin() { return useContext(AuthSessionContext)?.user?.role !== "user"; }
