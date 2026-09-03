const ENABLED_KEY = "posterview.rememberUsername";
const USERNAME_KEY = "posterview.savedUsername";
export const USERNAME_PREFERENCE_EVENT = "posterview:username-preference";

export function remembersUsername(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) !== "false"; } catch { return false; }
}

export function initialUsername(): string {
  if (!remembersUsername()) return "";
  try { return localStorage.getItem(USERNAME_KEY) ?? "admin"; } catch { return "admin"; }
}

export function rememberUsername(username: string): void {
  try {
    if (remembersUsername()) localStorage.setItem(USERNAME_KEY, username);
    else localStorage.removeItem(USERNAME_KEY);
  } catch { /* Sign-in still works when browser storage is disabled. */ }
}

export function setRememberUsername(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
    if (!enabled) localStorage.removeItem(USERNAME_KEY);
  } catch { /* Browser storage may be disabled. */ }
  window.dispatchEvent(new Event(USERNAME_PREFERENCE_EVENT));
}
