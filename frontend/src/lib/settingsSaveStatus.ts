export type SettingsSaveStatus = "saving" | "saved" | "error";

export function reportSettingsSave(status: SettingsSaveStatus) {
  window.dispatchEvent(new CustomEvent("posterview:settings-save", { detail: status }));
}
