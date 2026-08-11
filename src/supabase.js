import { createClient } from "@supabase/supabase-js";

// Values come from environment variables set in .env.local (dev) or
// GitHub Actions secrets (production build). See README.md for setup.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// --- Authentication (Supabase's built-in email + password) ---

export async function signUpWithPassword(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
  return data;
}

export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function inviteUser(email, name, redirectTo) {
  const { data, error } = await supabase.functions.invoke("invite-user", {
    body: { email, name, redirectTo },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function signOutUser() {
  await supabase.auth.signOut();
}

export async function getCurrentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Fires immediately with the current session, then again on every
// sign-in/out/recovery event. The event name lets the app tell a normal
// sign-in apart from someone arriving via a "reset your password" link.
export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data.subscription.unsubscribe();
}

// All shared app data lives in one Postgres table, one row per data set
// (users / trainings / progress), each holding a jsonb array. This mirrors
// the simple key-value shape the app was originally built around, just
// backed by Supabase instead of Claude's artifact storage.
const TABLE = "learning_ledger_data";

export function subscribeToKey(key, onChange) {
  let active = true;

  // Initial load
  (async () => {
    const { data, error } = await supabase.from(TABLE).select("value").eq("key", key).maybeSingle();
    if (!active) return;
    if (error) {
      console.error(`Supabase read error for "${key}":`, error);
      onChange([]);
      return;
    }
    onChange(data ? data.value : []);
  })();

  // Live updates
  const channel = supabase
    .channel(`ll-${key}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: TABLE, filter: `key=eq.${key}` },
      (payload) => {
        if (!active) return;
        const val = payload.new && "value" in payload.new ? payload.new.value : [];
        onChange(val);
      }
    )
    .subscribe();

  return () => {
    active = false;
    supabase.removeChannel(channel);
  };
}

export async function writeKey(key, value) {
  const { error } = await supabase.from(TABLE).upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}
