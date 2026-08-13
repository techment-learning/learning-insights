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
  if (error) {
    // supabase-js hides the actual response body on non-2xx by default —
    // dig it out of the underlying Response so errors are self-explanatory
    // instead of a generic "non-2xx status code" message.
    if (error.context && typeof error.context.json === "function") {
      try {
        const body = await error.context.json();
        if (body?.error) throw new Error(body.error);
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message !== error.message) throw parseErr;
      }
    }
    throw error;
  }
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

// --- Role authorization (checked by Postgres itself, not just the app) ---

export async function syncAppRole(authUserId, appUserId, role) {
  if (!authUserId) return;
  const { error } = await supabase.from("app_roles").upsert(
    { user_id: authUserId, app_user_id: appUserId, role, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

export async function deleteAppRole(authUserId) {
  if (!authUserId) return;
  const { error } = await supabase.from("app_roles").delete().eq("user_id", authUserId);
  if (error) throw error;
}

// --- Data storage ---
//
// "ltp-users" is backed by a real "profiles" table (one row per person),
// with a trigger enforcing that only an admin can change a role, email,
// or account link — while still allowing anyone to register themselves.
//
// "ltp-trainings", "ltp-progress", and "ltp-personal-plans" are backed by
// real Postgres tables (one row per record) with their own per-row RLS —
// see supabase/migrations/002_row_level_security.sql. The functions below
// translate transparently between the app's "array of JS objects" model
// and those tables, so none of the app's own code needed to change.
const TABLE = "learning_ledger_data";

const TABLE_CONFIG = {
  "ltp-users": {
    table: "profiles",
    toDb: (u) => ({
      id: u.id, auth_user_id: u.authUserId || null,
      name: u.name, email: u.email, role: u.role,
    }),
    fromDb: (r) => {
      const out = { id: r.id, name: r.name, email: r.email, role: r.role };
      if (r.auth_user_id) out.authUserId = r.auth_user_id;
      return out;
    },
  },
  "ltp-trainings": {
    table: "trainings",
    toDb: (t) => ({
      id: t.id, title: t.title, description: t.description || "",
      start_date: t.startDate, end_date: t.endDate,
      lesson_plan: t.lessonPlan || [], enrolled: t.enrolled || [],
      plan_locked_by_learner: !!t.planLockedByLearner,
    }),
    fromDb: (r) => ({
      id: r.id, title: r.title, description: r.description || "",
      startDate: r.start_date, endDate: r.end_date,
      lessonPlan: r.lesson_plan || [], enrolled: r.enrolled || [],
      planLockedByLearner: !!r.plan_locked_by_learner,
    }),
  },
  "ltp-progress": {
    table: "progress",
    toDb: (p) => ({
      id: p.id, training_id: p.trainingId, user_id: p.userId,
      topic_id: p.topicId ?? null, date: p.date ?? null,
      note: p.note ?? null, percent: p.percent ?? null,
    }),
    fromDb: (r) => {
      const out = { id: r.id, trainingId: r.training_id, userId: r.user_id, date: r.date };
      if (r.topic_id) out.topicId = r.topic_id;
      if (r.note) out.note = r.note;
      if (r.percent !== null && r.percent !== undefined) out.percent = r.percent;
      return out;
    },
  },
  "ltp-personal-plans": {
    table: "personal_plans",
    toDb: (p) => ({
      id: p.id, training_id: p.trainingId, user_id: p.userId,
      lesson_plan: p.lessonPlan || [], locked: !!p.locked,
    }),
    fromDb: (r) => ({
      id: r.id, trainingId: r.training_id, userId: r.user_id,
      lessonPlan: r.lesson_plan || [], locked: !!r.locked,
    }),
  },
};

export async function readKey(key) {
  const config = TABLE_CONFIG[key];
  if (config) {
    const { data, error } = await supabase.from(config.table).select("*");
    if (error) throw error;
    return (data || []).map(config.fromDb);
  }
  const { data, error } = await supabase.from(TABLE).select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data ? data.value : [];
}

export function subscribeToKey(key, onChange) {
  let active = true;
  const config = TABLE_CONFIG[key];

  if (config) {
    const load = async () => {
      const { data, error } = await supabase.from(config.table).select("*");
      if (!active) return;
      if (error) {
        console.error(`Supabase read error for "${key}":`, error);
        onChange([]);
        return;
      }
      onChange((data || []).map(config.fromDb));
    };
    load();
    const channel = supabase
      .channel(`tbl-${config.table}`)
      .on("postgres_changes", { event: "*", schema: "public", table: config.table }, load)
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }

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

// `fresh` is the exact snapshot the caller computed `value` from (see
// App.jsx's persist()) — diffing against that same snapshot, rather than
// re-reading the database again here, keeps the window for a race as small
// as possible and means only rows that actually changed get written, so a
// write never touches — or gets rejected for touching — rows the current
// person has no reason or permission to modify.
export async function writeKey(key, value, fresh) {
  const config = TABLE_CONFIG[key];
  if (!config) {
    const { error } = await supabase.from(TABLE).upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return;
  }

  const baseline = fresh || [];
  const baselineById = new Map(baseline.map((r) => [r.id, r]));
  const newIds = new Set(value.map((v) => v.id));

  const toDelete = [...baselineById.keys()].filter((id) => !newIds.has(id));
  const toUpsert = value
    .filter((v) => {
      const existing = baselineById.get(v.id);
      return !existing || JSON.stringify(existing) !== JSON.stringify(v);
    })
    .map(config.toDb);

  if (toUpsert.length) {
    const { error } = await supabase.from(config.table).upsert(toUpsert, { onConflict: "id" });
    if (error) throw error;
  }
  if (toDelete.length) {
    const { error } = await supabase.from(config.table).delete().in("id", toDelete);
    if (error) throw error;
  }
}
