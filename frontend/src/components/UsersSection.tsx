import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type UserAccount, type UserInput, type UserRole } from "../api/client";
import { nativeLibraries } from "../api/nativeLibraries";

const inputClass = "w-full rounded-lg border border-border bg-input px-3 py-2";
const movieRatings = ["G", "PG", "PG-13", "R", "NC-17"];
const tvRatings = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];

function newUser(): UserInput {
  return {
    username: "",
    display_name: "",
    password: "",
    role: "user",
    enabled: true,
    permissions: {
      all_libraries: true,
      library_ids: [],
      max_movie_rating: null,
      max_tv_rating: null,
      allow_unrated: false,
      max_playback_streams: 5,
    },
  };
}

export default function UsersSection() {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });
  const libraries = useQuery({ queryKey: ["native-libraries"], queryFn: nativeLibraries.list });
  const [editing, setEditing] = useState<UserAccount | null | undefined>();
  const [form, setForm] = useState<UserInput>(newUser);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<UserAccount | null>(null);

  function begin(account: UserAccount | null) {
    setEditing(account);
    setForm(account ? {
      username: account.username,
      display_name: account.display_name,
      role: account.role,
      enabled: account.enabled,
      password: "",
      permissions: { ...account.permissions, max_playback_streams: account.permissions.max_playback_streams ?? 5, library_ids: [...account.permissions.library_ids] },
    } : newUser());
    setError("");
    setNotice("");
  }

  function updatePolicy(change: Partial<UserInput["permissions"]>) {
    setForm({ ...form, permissions: { ...form.permissions, ...change } });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!form.username.trim() || !form.display_name.trim()) {
      setError("Enter a username and display name.");
      return;
    }
    if ((!editing || form.password) && form.password.length < 8) {
      setError("Passwords must have at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const data = { ...form, username: form.username.trim(), display_name: form.display_name.trim() };
      if (editing) {
        await api.updateUser(editing.id, {
          ...data,
          revision: editing.revision,
          password: form.password || null,
        });
      } else {
        await api.createUser(data);
      }
      await client.invalidateQueries({ queryKey: ["users"] });
      window.dispatchEvent(new Event("posterview:security-changed"));
      setEditing(undefined);
      setNotice("User saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save user.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteUser(deleting.id);
      await client.invalidateQueries({ queryKey: ["users"] });
      setDeleting(null);
      setNotice("User deleted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete user.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          Administrators manage the server. Users can browse, watch and keep their own progress.
        </p>
        <button className="rounded-lg bg-accent px-4 py-2 font-medium text-black" onClick={() => begin(null)}>
          Create user
        </button>
      </div>
      {users.error && <p role="alert">{users.error.message}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      {notice && <p role="status" className="text-accent">{notice}</p>}
      {users.isPending && <p>Loading users…</p>}
      <div className="rounded-lg border border-border bg-elevated p-4 text-sm text-muted">
        <p>Library permissions apply to native PosterView libraries. Connected media server administration remains administrator-only.</p>
        <p className="mt-2">Individual sign-in is required while user accounts are enabled; local network login bypass cannot override their restrictions.</p>
      </div>
      <div className="divide-y divide-border">
        {users.data?.map(user => (
          <div key={user.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div>
              <h2 className="font-semibold">{user.display_name}</h2>
              <p className="text-sm text-muted">
                {user.username} · {user.role === "admin" ? "Administrator" : "User"} · {user.enabled ? "Enabled" : "Disabled"}
              </p>
              <p className="text-xs text-muted">
                {user.role === "admin" ? "Full server access" : user.permissions.all_libraries ? "All libraries" : `${user.permissions.library_ids.length} libraries`}
              </p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => begin(user)} className="rounded-lg border border-border px-4 py-2" aria-label={`Edit ${user.display_name}`}>
                Edit
              </button>
              <button onClick={() => { setDeleting(user); setError(""); }} className="px-3 py-2 text-danger" aria-label={`Delete ${user.display_name}`}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {deleting && (
        <section role="dialog" aria-label="Delete user" className="rounded-xl border border-danger p-5">
          <p>Delete {deleting.display_name}? Their account will be removed and they will lose access.</p>
          <div className="mt-4 flex gap-3">
            <button disabled={busy} onClick={() => void remove()} className="rounded-lg bg-danger px-4 py-2">Confirm deletion</button>
            <button disabled={busy} onClick={() => setDeleting(null)}>Cancel deletion</button>
          </div>
        </section>
      )}
      {editing !== undefined && (
        <form onSubmit={save} className="space-y-5 rounded-xl border border-border bg-surface p-5">
          <h2 className="text-xl font-semibold">{editing ? `Edit ${editing.display_name}` : "Create user"}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2">
              Username
              <input className={inputClass} required autoComplete="off" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} />
            </label>
            <label className="space-y-2">
              Display name
              <input className={inputClass} required value={form.display_name} onChange={event => setForm({ ...form, display_name: event.target.value })} />
            </label>
            <label className="space-y-2">
              {editing ? "New password (leave blank to keep current)" : "Password"}
              <input className={inputClass} type="password" autoComplete="new-password" required={!editing} minLength={8} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} />
            </label>
            <label className="space-y-2">
              Role
              <select className={inputClass} value={form.role} onChange={event => setForm({ ...form, role: event.target.value as UserRole })}>
                <option value="user">User</option>
                <option value="admin">Administrator</option>
              </select>
            </label>
          </div>
          <label className="flex gap-2">
            <input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} />
            Account enabled
          </label>
          <div className="space-y-2">
            <label className="block space-y-2">
              Simultaneous playback limit
              <input className={inputClass} type="number" min={0} max={64} step={1} required value={form.permissions.max_playback_streams ?? 5} onChange={event => updatePolicy({ max_playback_streams: event.target.valueAsNumber })} aria-describedby="playback-limit-help" />
            </label>
            <p id="playback-limit-help" className="text-sm text-muted">Use 0 for unlimited playback sessions. Original playback, Direct Stream and transcodes all count. Seeking and changing audio keep the same stream. Separate server FFmpeg job limits still apply.</p>
          </div>
          {form.role === "admin" ? (
            <p className="text-sm text-muted">
              Administrators have unrestricted library access and can change all server settings. Keep at least one enabled administrator.
            </p>
          ) : (
            <>
              <fieldset className="space-y-3">
                <legend className="mb-3 font-semibold">Library access</legend>
                <label className="flex gap-2">
                  <input type="checkbox" checked={form.permissions.all_libraries} onChange={event => updatePolicy({ all_libraries: event.target.checked })} />
                  Allow all libraries, including future libraries
                </label>
                {!form.permissions.all_libraries && (
                  <>
                    <p className="text-xs text-muted">Only selected libraries are accessible. Selecting none blocks all libraries.</p>
                    {libraries.error && <p role="alert">Could not load libraries: {libraries.error.message}</p>}
                    {libraries.data?.map(library => (
                      <label key={library.id} className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={form.permissions.library_ids.includes(library.id)}
                          onChange={event => updatePolicy({
                            library_ids: event.target.checked
                              ? [...form.permissions.library_ids, library.id]
                              : form.permissions.library_ids.filter(id => id !== library.id),
                          })}
                        />
                        {library.name}
                      </label>
                    ))}
                  </>
                )}
              </fieldset>
              <fieldset className="space-y-4">
                <legend className="mb-3 font-semibold">Content restrictions</legend>
                <p className="text-sm text-muted">Allow content up to the selected rating. Movie and TV ratings are evaluated separately.</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    Maximum movie rating
                    <select className={inputClass} value={form.permissions.max_movie_rating ?? ""} onChange={event => updatePolicy({ max_movie_rating: event.target.value || null })}>
                      <option value="">Unrestricted</option>
                      {movieRatings.map(rating => <option key={rating} value={rating}>{rating}</option>)}
                    </select>
                  </label>
                  <label>
                    Maximum TV rating
                    <select className={inputClass} value={form.permissions.max_tv_rating ?? ""} onChange={event => updatePolicy({ max_tv_rating: event.target.value || null })}>
                      <option value="">Unrestricted</option>
                      {tvRatings.map(rating => <option key={rating} value={rating}>{rating}</option>)}
                    </select>
                  </label>
                </div>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    disabled={!form.permissions.max_movie_rating && !form.permissions.max_tv_rating}
                    checked={form.permissions.allow_unrated}
                    onChange={event => updatePolicy({ allow_unrated: event.target.checked })}
                  />
                  Allow unrated or unrecognized ratings when restrictions apply
                </label>
              </fieldset>
            </>
          )}
          <div className="flex gap-4">
            <button type="submit" disabled={busy} className="rounded-lg bg-accent px-4 py-2 font-medium text-black">
              {busy ? "Saving…" : "Save user"}
            </button>
            <button type="button" disabled={busy} onClick={() => { setEditing(undefined); setError(""); }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
