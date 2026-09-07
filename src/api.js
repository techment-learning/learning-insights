// Learning Insights — Cloudflare Worker API client
//
// Replaces src/supabase.js. Keeps the same exported function names/shapes
// the rest of the app already calls (persist(), readKey(), writeKey(),
// subscribeToKey(), sign-in/up/out, password reset) so App.jsx needed only
// the auth-flow section changed, not a full rewrite.
//
// Set this to your deployed Worker's URL (see ../DEPLOY.md).
const API_URL = import.meta.env.VITE_API_URL;

const KEY_TO_COLLECTION = {
  "ltp-users": "users",
  "ltp-trainings": "trainings",
  "ltp-progress": "progress",
  "ltp-personal-plans": "personal_plans",
};

let sessionToken = localStorage.getItem("li_session_token") || null;
let currentUser = null;
const authListeners = [];

function setSession(token, user) {
  sessionToken = token;
  currentUser = user;
  if (token) localStorage.setItem("li_session_token", token);
  else localStorage.removeItem("li_session_token");
  authListeners.forEach((cb) => cb(currentUser ? { user: currentUser } : null));
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// --- Auth ---

export async function signUpWithPassword(email, password, fullName) {
  const data = await apiFetch("/api/auth/signup", { method: "POST", body: JSON.stringify({ name: fullName, email, password }) });
  setSession(data.token, data.user);
  return data;
}

export async function signInWithPassword(email, password) {
  const data = await apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  setSession(data.token, data.user);
  return data;
}

export async function signOutUser() {
  try { await apiFetch("/api/auth/logout", { method: "POST" }); } catch {}
  setSession(null, null);
}

export async function sendPasswordReset(email) {
  await apiFetch("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
}

// The reset link from email looks like: yourapp.github.io/?resetToken=XXXX
// Read it once at startup — no separate "recovery session" step needed,
// since our reset endpoint verifies the token itself rather than relying
// on an already-established session like Supabase's magic-link flow did.
export function getPendingResetToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("resetToken");
}

export async function updatePassword(newPassword) {
  const token = getPendingResetToken();
  if (!token) throw new Error("No reset link found — use the link from your email.");
  const data = await apiFetch("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) });
  setSession(data.token, data.user);
  window.history.replaceState(null, "", window.location.pathname);
}

export async function inviteUser(email, name, role) {
  return apiFetch("/api/auth/invite", { method: "POST", body: JSON.stringify({ email, name, role }) });
}

export async function getCurrentSession() {
  if (!sessionToken) return null;
  try {
    const data = await apiFetch("/api/auth/me");
    currentUser = data.user;
    return { user: data.user };
  } catch {
    setSession(null, null);
    return null;
  }
}

// Fires once immediately with the current session (or null), then again on
// every sign-in/out. There's no distinct "recovery" event here since the
// reset link is detected directly from the URL (see getPendingResetToken).
export function onAuthChange(callback) {
  authListeners.push(callback);
  getCurrentSession().then((session) => callback(session));
  return () => {
    const i = authListeners.indexOf(callback);
    if (i >= 0) authListeners.splice(i, 1);
  };
}

// --- Data ---

export async function readKey(key) {
  const collection = KEY_TO_COLLECTION[key];
  const data = await apiFetch(`/api/collection/${collection}`);
  return data.data;
}

// Polling stand-in for realtime: fetch immediately, then on an interval.
// True push updates would need Durable Objects — this is the pragmatic
// choice for how this app is actually used (not sub-second latency).
export function subscribeToKey(key, onChange) {
  let active = true;
  const collection = KEY_TO_COLLECTION[key];

  const load = async () => {
    if (!sessionToken) return;
    try {
      const data = await apiFetch(`/api/collection/${collection}`);
      if (active) onChange(data.data);
    } catch (e) {
      console.error(`Poll error for "${key}":`, e);
    }
  };

  load();
  // 60s (not shorter) is deliberate: Cloudflare's free Worker plan caps
  // requests at 100,000/day, strictly enforced as of Sept 2026 (queries
  // fail once you cross it, not just billed like Supabase's overage
  // model). With 4 collections polling per open tab, a full team leaving
  // tabs open all day adds up fast — 60s keeps generous headroom while
  // still feeling responsive for how this app is actually used.
  const POLL_INTERVAL_MS = 60000;
  const interval = setInterval(load, POLL_INTERVAL_MS);
  return () => {
    active = false;
    clearInterval(interval);
  };
}

export async function writeKey(key, value, fresh) {
  const collection = KEY_TO_COLLECTION[key];
  const baseline = fresh || [];
  const baselineById = new Map(baseline.map((r) => [r.id, r]));
  const newIds = new Set(value.map((v) => v.id));

  const toDelete = [...baselineById.keys()].filter((id) => !newIds.has(id));
  const toUpsert = value.filter((v) => {
    const existing = baselineById.get(v.id);
    return !existing || JSON.stringify(existing) !== JSON.stringify(v);
  });

  for (const row of toUpsert) {
    await apiFetch(`/api/collection/${collection}`, { method: "POST", body: JSON.stringify(row) });
  }
  for (const id of toDelete) {
    await apiFetch(`/api/collection/${collection}/${id}`, { method: "DELETE" });
  }
}
