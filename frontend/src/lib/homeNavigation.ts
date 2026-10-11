export const HOME_RESET_EVENT = "posterview:reset-home-navigation";
export function resetHomeNavigation() { window.dispatchEvent(new Event(HOME_RESET_EVENT)); }
