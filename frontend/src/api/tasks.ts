import { apiRequest } from "./client";
export interface TaskConfig {
  name: string; kind: string;
  providers: string[]; enabled: boolean; interval_hours: number; stale_days: number;
}
export interface ScheduledTask {
  id: string; config: TaskConfig; status: string; next_run: number | null;
  started_at: number | null; finished_at: number | null; processed: number; total: number; updated: number;
  skipped: number; failed: number; needs_matching: number; current_title: string | null; message: string;
  issues: { server_id: number; item_id: string; title: string; message: string; needs_matching: boolean }[];
  history: { finished_at: number; status: string; processed: number; updated: number; failed: number; needs_matching: number }[];
}
export const tasksApi = {
  list: () => apiRequest<ScheduledTask[]>("/tasks"),
  save: (config: TaskConfig, id?: string) => apiRequest<ScheduledTask>(id ? `/tasks/${id}` : "/tasks", { method: id ? "PUT" : "POST", body: JSON.stringify(config) }),
  action: (id: string, action: string) => apiRequest<ScheduledTask[]>(`/tasks/${id}/${action}`, { method: "POST" }),
};
