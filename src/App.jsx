import React, { useState, useEffect, useMemo } from "react";
import {
  BookOpen, Users, AlertTriangle, CheckCircle2, Clock, Plus, Mail,
  LogOut, ChevronRight, TrendingUp, Calendar, X, FileText, UserPlus,
  ClipboardList, ArrowLeft, Filter, RotateCcw, Pencil, Trash2, UserMinus, Download, Copy
} from "lucide-react";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid
} from "recharts";
import { subscribeToKey, writeKey, readKey, signUpWithPassword, signInWithPassword, sendPasswordReset, updatePassword, signOutUser, onAuthChange, inviteUser, syncAppRole, deleteAppRole } from "./supabase";

// Only people signing up with this email domain are let into the app.
// Change this to your organization's real domain, or set to "" to disable.
const ALLOWED_EMAIL_DOMAIN = "techment.com";

// ---------- Design tokens ----------
const T = {
  bg: "#FFFFFF",
  surface: "#F5F7FA",
  surfaceRaised: "#FFFFFF",
  line: "#E1E5EB",
  ink: "#1A1F2B",
  inkMuted: "#5B6472",
  inkFaint: "#8891A0",
  brand: "#3F79DA",
  brandDim: "#E8EFFC",
  onTrack: "#0EA66E",
  onTrackDim: "#E3FBF1",
  progress: "#C07A1E",
  progressDim: "#FCF1DD",
  delayed: "#D6483C",
  delayedDim: "#FBE9E7",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif",
  mono: "'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
};

const uid = () => Math.random().toString(36).slice(2, 10);

function downloadCSV(filename, rows) {
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    const s = val === null || val === undefined ? "" : String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Supabase includes a "type" param (invite, recovery, signup, magiclink) in
// the URL when someone lands here from an email link. We use this as a
// belt-and-suspenders check alongside the PASSWORD_RECOVERY auth event,
// since an invite link should also land on the "set a password" screen.
function getAuthLinkType() {
  const raw = (window.location.hash || window.location.search || "").replace(/^[#?]/, "");
  return new URLSearchParams(raw).get("type");
}
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const addDays = (dateStr, days) => {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// --- Personal plan resolution ---
// A learner can branch off into their own copy of a training's lesson plan.
// Everywhere else in the app just asks "what's this learner's effective
// plan?" and gets back either their personal one or the shared default —
// nothing else needs to know which.
function getPersonalPlan(training, userId, personalPlans) {
  return personalPlans.find((p) => p.trainingId === training.id && p.userId === userId);
}
function effectiveLessonPlan(training, userId, personalPlans) {
  const pp = getPersonalPlan(training, userId, personalPlans);
  return pp ? pp.lessonPlan : (training.lessonPlan || []);
}
function effectiveTrainingFor(training, userId, personalPlans) {
  return { ...training, lessonPlan: effectiveLessonPlan(training, userId, personalPlans) };
}
function isPlanLocked(training, userId, personalPlans) {
  const pp = getPersonalPlan(training, userId, personalPlans);
  return pp ? !!pp.locked : !!training.planLockedByLearner;
}

function statusFromPcts(plannedPct, actualPct) {
  if (actualPct >= 100) return "Completed";
  if (plannedPct === 0 && actualPct === 0) return "Not Started";
  if (actualPct >= plannedPct) return "On Track";
  const gap = plannedPct - actualPct;
  const ratio = plannedPct > 0 ? gap / plannedPct : 0;
  return ratio >= 0.5 ? "Delayed" : "In Progress";
}

function computeStatus(training, userId, progress) {
  const today = todayISO();

  // --- Topic/lesson-plan based tracking (preferred) ---
  if (training.lessonPlan && training.lessonPlan.length > 0) {
    const total = training.lessonPlan.length;
    const completions = progress.filter((p) => p.trainingId === training.id && p.userId === userId && p.topicId);
    const doneIds = new Set(completions.map((c) => c.topicId));
    const actualCount = training.lessonPlan.filter((l) => doneIds.has(l.id)).length;
    const plannedCount = training.lessonPlan.filter((l) => l.expectedDate <= today).length;
    const actualPct = Math.round((actualCount / total) * 100);
    const plannedPct = Math.round((plannedCount / total) * 100);
    const lastUpdate = completions.length
      ? completions.reduce((a, b) => (a.date > b.date ? a : b)).date
      : null;
    const overdueTopics = training.lessonPlan.filter((l) => l.expectedDate < today && !doneIds.has(l.id));
    return {
      plannedPct, actualPct, status: statusFromPcts(plannedPct, actualPct),
      lastUpdate, totalTopics: total, doneCount: actualCount, overdueTopics, mode: "topics",
    };
  }

  // --- Legacy: date-range + % slider tracking ---
  const start = training.startDate, end = training.endDate;
  const totalDays = Math.max(1, daysBetween(start, end));
  const entries = progress
    .filter((p) => p.trainingId === training.id && p.userId === userId && p.percent !== undefined)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const actualPct = entries.length ? entries[0].percent : 0;
  const lastUpdate = entries.length ? entries[0].date : null;

  if (today < start) {
    return { plannedPct: 0, actualPct, status: "Not Started", lastUpdate, totalDays, mode: "legacy" };
  }
  const elapsed = Math.min(totalDays, Math.max(0, daysBetween(start, today)));
  const plannedPct = Math.round((elapsed / totalDays) * 100);
  return { plannedPct, actualPct, status: statusFromPcts(plannedPct, actualPct), lastUpdate, totalDays, mode: "legacy" };
}

const STATUS_STYLE = {
  "On Track": { color: T.onTrack, bg: T.onTrackDim, icon: CheckCircle2 },
  "In Progress": { color: T.progress, bg: T.progressDim, icon: Clock },
  "Delayed": { color: T.delayed, bg: T.delayedDim, icon: AlertTriangle },
  "Not Started": { color: T.inkFaint, bg: T.surfaceRaised, icon: Clock },
  "Completed": { color: T.brand, bg: T.brandDim, icon: CheckCircle2 },
};

// ---------- Ledger bar (signature element) ----------
function LedgerBar({ plannedPct, actualPct, status, compact }) {
  const style = STATUS_STYLE[status];
  const h = compact ? 10 : 14;
  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          position: "relative",
          height: h,
          background: T.surface,
          border: `1px solid ${T.line}`,
          borderRadius: 3,
          overflow: "visible",
        }}
      >
        {/* actual fill */}
        <div
          style={{
            position: "absolute",
            left: 0, top: 0, bottom: 0,
            width: `${Math.min(100, actualPct)}%`,
            background: style.color,
            opacity: 0.85,
            borderRadius: 3,
            transition: "width 0.3s ease",
          }}
        />
        {/* tick marks every 25% */}
        {[25, 50, 75].map((t) => (
          <div key={t} style={{
            position: "absolute", left: `${t}%`, top: 0, bottom: 0, width: 1,
            background: T.bg, opacity: 0.5,
          }} />
        ))}
        {/* planned marker */}
        <div
          title={`Planned: ${plannedPct}%`}
          style={{
            position: "absolute",
            left: `${Math.min(100, plannedPct)}%`,
            top: -3, bottom: -3, width: 2,
            background: T.ink,
            transform: "translateX(-1px)",
          }}
        />
      </div>
      {!compact && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontFamily: T.mono, fontSize: 11, color: T.inkMuted }}>
          <span>actual {actualPct}%</span>
          <span>planned (pace) {plannedPct}%</span>
          <span>target 100%</span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, size = "sm" }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: size === "sm" ? "3px 8px" : "5px 11px",
      borderRadius: 20, background: s.bg, color: s.color,
      fontSize: size === "sm" ? 11 : 12, fontFamily: T.sans, fontWeight: 600,
      letterSpacing: 0.2, whiteSpace: "nowrap",
    }}>
      <Icon size={size === "sm" ? 11 : 13} />
      {status}
    </span>
  );
}

function Btn({ children, onClick, variant = "primary", style = {}, ...rest }) {
  const base = {
    fontFamily: T.sans, fontWeight: 600, fontSize: 13.5, borderRadius: 8,
    padding: "9px 16px", cursor: "pointer", border: "1px solid transparent",
    display: "inline-flex", alignItems: "center", gap: 6, transition: "opacity 0.15s",
  };
  const variants = {
    primary: { background: T.brand, color: "#FFFFFF" },
    ghost: { background: "transparent", color: T.ink, border: `1px solid ${T.line}` },
    danger: { background: "transparent", color: T.delayed, border: `1px solid ${T.delayed}44` },
  };
  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = 0.8)}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = 1)}
      style={{ ...base, ...variants[variant], ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: T.inkMuted, marginBottom: 6, fontFamily: T.sans, fontWeight: 600, letterSpacing: 0.3 }}>
        {label}
      </div>
      {children}
    </label>
  );
}

const inputStyle = {
  width: "100%", background: T.surface, border: `1px solid ${T.line}`,
  borderRadius: 7, padding: "9px 11px", color: T.ink, fontFamily: T.sans,
  fontSize: 14, outline: "none", boxSizing: "border-box",
};

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(8,9,13,0.7)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }} onClick={onClose}>
      <div
        style={{
          background: T.surfaceRaised, border: `1px solid ${T.line}`, borderRadius: 12,
          padding: 24, width: "100%", maxWidth: wide ? 640 : 440, maxHeight: "85vh", overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h3 style={{ fontFamily: T.serif, fontSize: 20, color: T.ink, margin: 0 }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.inkMuted, cursor: "pointer", padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Main App ----------
export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [users, setUsers] = useState([]);
  const [trainings, setTrainings] = useState([]);
  const [progress, setProgress] = useState([]);
  const [personalPlans, setPersonalPlans] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authSession, setAuthSession] = useState(null);
  const [authEvent, setAuthEvent] = useState(null);
  const [forcePasswordSetup, setForcePasswordSetup] = useState(() => ["invite", "recovery"].includes(getAuthLinkType()));
  const [authError, setAuthError] = useState(null);
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState(null);

  // modals
  const [showAddUser, setShowAddUser] = useState(false);
  const [showAddTraining, setShowAddTraining] = useState(false);
  const [showEnroll, setShowEnroll] = useState(null); // training obj
  const [showUpdate, setShowUpdate] = useState(null); // training obj (learner)
  const [showAddTopic, setShowAddTopic] = useState(null); // { training, personalUserId? }
  const [showEditTopic, setShowEditTopic] = useState(null); // { training, topic, personalUserId? }
  const [showEditTraining, setShowEditTraining] = useState(null); // training obj
  const [showCloneTraining, setShowCloneTraining] = useState(null); // training obj
  const [showCreatePlan, setShowCreatePlan] = useState(null); // { training, willLock } (shared/default plan)
  const [showCustomizePlan, setShowCustomizePlan] = useState(null); // training obj (learner's own personal plan)
  const [showReport, setShowReport] = useState(false);

  useEffect(() => {
    let gotUsers = false, gotTrainings = false, gotProgress = false, gotPersonalPlans = false;
    const markLoaded = () => {
      if (gotUsers && gotTrainings && gotProgress && gotPersonalPlans) setLoaded(true);
    };
    const unsubUsers = subscribeToKey("ltp-users", (v) => { setUsers(v); gotUsers = true; markLoaded(); });
    const unsubTrainings = subscribeToKey("ltp-trainings", (v) => { setTrainings(v); gotTrainings = true; markLoaded(); });
    const unsubProgress = subscribeToKey("ltp-progress", (v) => { setProgress(v); gotProgress = true; markLoaded(); });
    const unsubPersonalPlans = subscribeToKey("ltp-personal-plans", (v) => { setPersonalPlans(v); gotPersonalPlans = true; markLoaded(); });
    return () => { unsubUsers(); unsubTrainings(); unsubProgress(); unsubPersonalPlans(); };
  }, []);

  useEffect(() => {
    const unsub = onAuthChange((event, session) => {
      setAuthSession(session);
      setAuthEvent(event);
      setAuthChecked(true);
    });
    return unsub;
  }, []);

  // Once we know both who's signed in and the shared user list, match the
  // signed-in email to an existing account, or auto-create one.
  useEffect(() => {
    if (!authChecked || !loaded) return;
    if (!authSession) { setCurrentUser(null); return; }

    const email = (authSession.user.email || "").toLowerCase();
    if (!email) return;

    if (ALLOWED_EMAIL_DOMAIN && !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      setAuthError(`Please sign in with your official @${ALLOWED_EMAIL_DOMAIN} email.`);
      signOutUser();
      return;
    }

    const existing = users.find((u) => (u.email || "").toLowerCase() === email);
    const authUserId = authSession.user.id;

    if (existing) {
      (async () => {
        const freshUsers = await readKey("ltp-users");
        const freshExisting = freshUsers.find((u) => u.id === existing.id) || existing;
        const freshAnyAdmin = freshUsers.some((u) => u.role === "admin");
        let finalUser = { ...freshExisting, authUserId };
        let intendedRole = finalUser.role;

        if (!freshAnyAdmin) {
          // Nobody in the workspace is admin (e.g. this person was pre-added
          // as a learner before ever signing in, and no one else became
          // admin either) — promote them now instead of leaving the
          // workspace stuck with no admin at all.
          intendedRole = "admin";
        }

        // The database is the real authority on admin status — it will
        // refuse to let someone grant themselves "admin" unless the
        // bootstrap case above applies. If this person was pre-provisioned
        // as admin by someone else but the database can't verify that yet
        // (an admin already exists and hasn't confirmed them), fall back
        // to learner rather than leaving the app and the database
        // disagreeing about their access.
        try {
          await syncAppRole(authUserId, finalUser.id, intendedRole);
          finalUser.role = intendedRole;
        } catch (e) {
          console.error("Role sync rejected by database, falling back to learner:", e);
          finalUser.role = "learner";
          try { await syncAppRole(authUserId, finalUser.id, "learner"); } catch {}
        }

        const nextUsers = freshUsers.map((u) => u.id === finalUser.id ? finalUser : u);
        setUsers(nextUsers);
        await writeKey("ltp-users", nextUsers);
        setCurrentUser(finalUser);
      })();
      return;
    }

    // First-ever sign-in becomes admin; everyone after that starts as a learner
    // (an admin can promote them from Users later).
    const displayName = authSession.user.user_metadata?.full_name || authSession.user.user_metadata?.name || email.split("@")[0];
    (async () => {
      const freshUsers = await readKey("ltp-users");
      const freshExisting = freshUsers.find((u) => (u.email || "").toLowerCase() === email);
      if (freshExisting) { setCurrentUser({ ...freshExisting, authUserId }); return; }

      const freshAnyAdmin = freshUsers.some((u) => u.role === "admin");
      const intendedRole = freshAnyAdmin ? "learner" : "admin";
      const newAppUserId = uid();
      let finalRole = intendedRole;
      try {
        await syncAppRole(authUserId, newAppUserId, intendedRole);
      } catch (e) {
        console.error("Role sync rejected by database, falling back to learner:", e);
        finalRole = "learner";
        try { await syncAppRole(authUserId, newAppUserId, "learner"); } catch {}
      }

      const newUser = { id: newAppUserId, name: displayName, email, role: finalRole, authUserId };
      const nextUsers = [...freshUsers, newUser];
      setUsers(nextUsers);
      await writeKey("ltp-users", nextUsers);
      setCurrentUser(newUser);
    })();
  }, [authChecked, authSession, loaded, users]);

  // currentUser is kept out of Firestore on purpose — it's this browser's
  // session only, not shared data. It's held in memory (no localStorage,
  // per the login screen's own profile picker each time the page loads).
  // Every save reads the LIVE server value first and applies the change to
  // that, then writes the result back — not the browser's local snapshot,
  // which can go stale (a tab left open a while, or someone else's change
  // landing in between) and silently overwrite newer data if trusted as-is.
  // Pass a function (fresh => nextValue) for any read-modify-write; pass a
  // plain value only when you genuinely want to replace the whole thing.
  async function persist(key, valueOrUpdater, setter) {
    try {
      let finalValue, fresh;
      if (typeof valueOrUpdater === "function") {
        fresh = await readKey(key);
        finalValue = valueOrUpdater(fresh);
      } else {
        finalValue = valueOrUpdater;
      }
      setter(finalValue);
      await writeKey(key, finalValue, fresh);
      return finalValue;
    } catch (e) {
      console.error(e);
      showToast(e.message && e.message !== "Failed to fetch" ? e.message : "Could not save — check your connection", true);
    }
  }
  function showToast(msg, isError) {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 2600);
  }

  async function handleDeleteTopic(training, topic, personalUserId) {
    if (!window.confirm(`Delete "${topic.topic}" from the lesson plan? This also removes the completion record for it.`)) return;
    if (personalUserId) {
      await persist("ltp-personal-plans", (fresh) =>
        fresh.map((p) =>
          p.trainingId === training.id && p.userId === personalUserId
            ? { ...p, lessonPlan: p.lessonPlan.filter((l) => l.id !== topic.id) }
            : p
        ), setPersonalPlans);
      await persist("ltp-progress", (fresh) =>
        fresh.filter((p) => !(p.trainingId === training.id && p.userId === personalUserId && p.topicId === topic.id)),
        setProgress);
    } else {
      await persist("ltp-trainings", (fresh) =>
        fresh.map((t) => t.id === training.id ? { ...t, lessonPlan: (t.lessonPlan || []).filter((l) => l.id !== topic.id) } : t),
        setTrainings);
      await persist("ltp-progress", (fresh) =>
        fresh.filter((p) => !(p.trainingId === training.id && p.topicId === topic.id)),
        setProgress);
    }
    showToast("Topic deleted");
  }

  async function handleCustomizePlan(training, topics) {
    await persist("ltp-personal-plans", (fresh) => {
      const existing = fresh.find((p) => p.trainingId === training.id && p.userId === currentUser.id);
      return existing
        ? fresh.map((p) => p.id === existing.id ? { ...p, lessonPlan: topics, locked: true } : p)
        : [...fresh, { id: uid(), trainingId: training.id, userId: currentUser.id, lessonPlan: topics, locked: true }];
    }, setPersonalPlans);
    setShowCustomizePlan(null);
    showToast("Your custom plan is saved and locked");
  }

  async function handleRevertToSharedPlan(training) {
    if (!window.confirm("Switch back to the admin's shared plan? Your custom topics and their completion records will be removed.")) return;
    const freshPersonal = await readKey("ltp-personal-plans");
    const pp = freshPersonal.find((p) => p.trainingId === training.id && p.userId === currentUser.id);
    if (!pp) return;
    const personalTopicIds = new Set(pp.lessonPlan.map((l) => l.id));
    await persist("ltp-personal-plans", (fresh) => fresh.filter((p) => p.id !== pp.id), setPersonalPlans);
    await persist("ltp-progress", (fresh) =>
      fresh.filter((p) => !(p.trainingId === training.id && p.userId === currentUser.id && personalTopicIds.has(p.topicId))),
      setProgress);
    showToast("Switched back to the shared plan");
  }

  async function handleDeleteTraining(training) {
    if (!window.confirm(`Delete "${training.title}"? This removes the entire training, its lesson plan, and everyone's progress on it. This can't be undone.`)) return;
    await persist("ltp-trainings", (fresh) => fresh.filter((t) => t.id !== training.id), setTrainings);
    await persist("ltp-progress", (fresh) => fresh.filter((p) => p.trainingId !== training.id), setProgress);
    showToast(`"${training.title}" deleted`);
  }

  async function handleCloneTraining(training, newTitle, newStartDate, newEndDate) {
    const offset = daysBetween(training.startDate, newStartDate);
    let clamped = false;
    const shiftedTopics = (training.lessonPlan || []).map((l) => {
      let shifted = addDays(l.expectedDate, offset);
      if (shifted < newStartDate) { shifted = newStartDate; clamped = true; }
      if (shifted > newEndDate) { shifted = newEndDate; clamped = true; }
      return { id: uid(), topic: l.topic, expectedDate: shifted };
    });
    const newTraining = {
      id: uid(), title: newTitle, description: training.description || "",
      startDate: newStartDate, endDate: newEndDate,
      lessonPlan: shiftedTopics, enrolled: [], planLockedByLearner: false,
    };
    await persist("ltp-trainings", (fresh) => [...fresh, newTraining], setTrainings);
    setShowCloneTraining(null);
    showToast(clamped
      ? `"${newTitle}" created — some topic dates were adjusted to fit the shorter window`
      : `"${newTitle}" created`);
  }

  async function handleCreatePlan(training, topics, willLock) {
    await persist("ltp-trainings", (fresh) =>
      fresh.map((t) => t.id === training.id ? { ...t, lessonPlan: topics, planLockedByLearner: willLock } : t),
      setTrainings);
    setShowCreatePlan(null);
    showToast(willLock ? "Learning plan submitted and locked" : "Learning plan saved");
  }

  async function handleSubmitPlan(training) {
    if (!window.confirm("Submit this learning plan? Once submitted, only an admin can edit or delete topics — you'll still be able to check off completion and log dates any time.")) return;
    await persist("ltp-trainings", (fresh) => fresh.map((t) => t.id === training.id ? { ...t, planLockedByLearner: true } : t), setTrainings);
    showToast("Plan submitted");
  }

  async function handleUnenroll(training, user) {
    if (!window.confirm(`Remove ${user.name} from "${training.title}"? Their progress on this training is kept, but they'll no longer see it.`)) return;
    await persist("ltp-trainings", (fresh) =>
      fresh.map((t) => t.id === training.id ? { ...t, enrolled: t.enrolled.filter((id) => id !== user.id) } : t),
      setTrainings);
    showToast(`${user.name} removed from ${training.title}`);
  }

  async function handleDeleteUser(user) {
    const freshUsers = await readKey("ltp-users");
    if (user.role === "admin" && freshUsers.filter((u) => u.role === "admin").length <= 1) {
      showToast("Can't delete the only admin — promote someone else first", true);
      return;
    }
    if (!window.confirm(`Delete ${user.name}? This removes them from all trainings and their full progress history. This can't be undone.`)) return;
    if (user.authUserId) {
      try { await deleteAppRole(user.authUserId); } catch (e) { console.error(e); }
    }
    await persist("ltp-users", (fresh) => fresh.filter((u) => u.id !== user.id), setUsers);
    await persist("ltp-trainings", (fresh) => fresh.map((t) => ({ ...t, enrolled: t.enrolled.filter((id) => id !== user.id) })), setTrainings);
    await persist("ltp-progress", (fresh) => fresh.filter((p) => p.userId !== user.id), setProgress);
    showToast(`${user.name} deleted`);
  }

  const alerts = useMemo(() => {
    if (!currentUser) return [];
    const list = [];
    trainings.forEach((tr) => {
      tr.enrolled.forEach((userId) => {
        const s = computeStatus(effectiveTrainingFor(tr, userId, personalPlans), userId, progress);
        if (s.status === "Delayed") {
          const u = users.find((x) => x.id === userId);
          list.push({ training: tr, user: u, ...s });
        }
      });
    });
    return list;
  }, [trainings, progress, users, currentUser, personalPlans]);

  if (!loaded || !authChecked) {
    return <Shell><div style={{ color: T.inkMuted, fontFamily: T.sans, padding: 40 }}>Loading your workspace…</div></Shell>;
  }

  if (authEvent === "PASSWORD_RECOVERY" || forcePasswordSetup) {
    return <SetNewPassword onDone={() => {
      setAuthEvent(null);
      setForcePasswordSetup(false);
      window.history.replaceState(null, "", window.location.pathname);
    }} />;
  }

  if (!currentUser) {
    return (
      <Login
        onSignIn={signInWithPassword}
        onSignUp={(email, password, name) => signUpWithPassword(email, password, name)}
        onForgotPassword={sendPasswordReset}
        error={authError}
      />
    );
  }

  const isAdmin = currentUser.role === "admin";
  const myEnrolled = trainings.filter((t) => t.enrolled.includes(currentUser.id));

  return (
    <Shell>
      {/* Top bar */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "18px 26px", borderBottom: `1px solid ${T.line}`, flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 6, background: T.brandDim,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <BookOpen size={16} color={T.brand} />
          </div>
          <div>
            <div style={{ fontFamily: T.serif, fontSize: 18, color: T.ink, lineHeight: 1 }}>Techment - Learning Insights</div>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.inkFaint, letterSpacing: 0.5, marginTop: 2 }}>
              PROGRESS AGAINST PLAN
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {isAdmin && alerts.length > 0 && (
            <button onClick={() => setView("dashboard")} style={{
              display: "flex", alignItems: "center", gap: 6, background: T.delayedDim,
              border: `1px solid ${T.delayed}44`, color: T.delayed, borderRadius: 20,
              padding: "5px 12px", fontFamily: T.sans, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
            }}>
              <AlertTriangle size={13} /> {alerts.length} delayed
            </button>
          )}
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: T.sans, fontSize: 13.5, color: T.ink, fontWeight: 600 }}>{currentUser.name}</div>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.inkFaint, textTransform: "uppercase" }}>{currentUser.role}</div>
          </div>
          <button onClick={() => signOutUser()} title="Sign out" style={{
            background: "none", border: `1px solid ${T.line}`, borderRadius: 7, padding: 8, color: T.inkMuted, cursor: "pointer",
          }}>
            <LogOut size={14} />
          </button>
        </div>
      </div>

      {/* Nav */}
      <div style={{ display: "flex", gap: 4, padding: "12px 26px 0", borderBottom: `1px solid ${T.line}` }}>
        {(isAdmin
          ? [["dashboard", "Dashboard", TrendingUp], ["trainings", "Trainings", BookOpen], ["users", "Users", Users], ["reports", "Reports", FileText]]
          : [["dashboard", "My Learning", BookOpen], ["reports", "My Reports", TrendingUp]]
        ).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setView(key)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "10px 14px", fontFamily: T.sans, fontSize: 13.5, fontWeight: 600,
            color: view === key ? T.ink : T.inkMuted,
            borderBottom: view === key ? `2px solid ${T.brand}` : "2px solid transparent",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <div style={{ padding: 26, maxWidth: 1100, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
        {isAdmin && view === "dashboard" && (
          <AdminDashboard trainings={trainings} users={users} progress={progress} alerts={alerts} personalPlans={personalPlans}
            onAddTraining={() => setShowAddTraining(true)} onEnroll={(t) => setShowEnroll(t)}
            onAddTopic={(t, personalUserId) => setShowAddTopic({ training: t, personalUserId })}
            onEditTopic={(t, topic, personalUserId) => setShowEditTopic({ training: t, topic, personalUserId })}
            onDeleteTopic={(t, topic, personalUserId) => handleDeleteTopic(t, topic, personalUserId)}
            onUnenroll={(t, u) => handleUnenroll(t, u)}
            onCreatePlan={(t) => setShowCreatePlan({ training: t, willLock: false })}
            onEditTraining={(t) => setShowEditTraining(t)}
            onDeleteTraining={(t) => handleDeleteTraining(t)}
            onCloneTraining={(t) => setShowCloneTraining(t)} />
        )}
        {isAdmin && view === "trainings" && (
          <TrainingsView trainings={trainings} users={users} progress={progress} personalPlans={personalPlans}
            onAdd={() => setShowAddTraining(true)} onEnroll={(t) => setShowEnroll(t)}
            onAddTopic={(t, personalUserId) => setShowAddTopic({ training: t, personalUserId })}
            onEditTopic={(t, topic, personalUserId) => setShowEditTopic({ training: t, topic, personalUserId })}
            onDeleteTopic={(t, topic, personalUserId) => handleDeleteTopic(t, topic, personalUserId)}
            onUnenroll={(t, u) => handleUnenroll(t, u)}
            onCreatePlan={(t) => setShowCreatePlan({ training: t, willLock: false })}
            onEditTraining={(t) => setShowEditTraining(t)}
            onDeleteTraining={(t) => handleDeleteTraining(t)}
            onCloneTraining={(t) => setShowCloneTraining(t)} />
        )}
        {isAdmin && view === "users" && (
          <UsersView users={users} trainings={trainings} onAdd={() => setShowAddUser(true)} currentUserId={currentUser.id}
            onChangeRole={async (u, newRole) => {
              if (!window.confirm(`Make ${u.name} ${newRole === "admin" ? "an admin" : "a learner"}? ${newRole === "learner" ? "They'll lose admin access immediately." : ""}`)) return;
              if (u.authUserId) {
                try {
                  await syncAppRole(u.authUserId, u.id, newRole);
                } catch (e) {
                  console.error(e);
                  showToast("Database rejected this role change", true);
                  return;
                }
              }
              await persist("ltp-users", (fresh) => fresh.map((x) => x.id === u.id ? { ...x, role: newRole } : x), setUsers);
              showToast(`${u.name} is now ${newRole}`);
            }}
            onDeleteUser={handleDeleteUser} />
        )}
        {isAdmin && view === "reports" && (
          <ReportsView trainings={trainings} users={users} progress={progress} personalPlans={personalPlans} onOpenReport={() => setShowReport(true)} />
        )}
        {!isAdmin && view === "dashboard" && (
          <LearnerDashboard trainings={myEnrolled} progress={progress} currentUser={currentUser} personalPlans={personalPlans}
            onUpdate={(t) => setShowUpdate(t)}
            onAddTopic={(t, personalUserId) => setShowAddTopic({ training: t, personalUserId })}
            onEditTopic={(t, topic, personalUserId) => setShowEditTopic({ training: t, topic, personalUserId })}
            onDeleteTopic={(t, topic, personalUserId) => handleDeleteTopic(t, topic, personalUserId)}
            onCreatePlan={(t) => setShowCreatePlan({ training: t, willLock: true })}
            onSubmitPlan={(t) => handleSubmitPlan(t)}
            onCustomizePlan={(t) => setShowCustomizePlan(t)}
            onRevertToSharedPlan={(t) => handleRevertToSharedPlan(t)} />
        )}
        {!isAdmin && view === "reports" && (
          <LearnerReports trainings={myEnrolled} progress={progress} currentUser={currentUser} personalPlans={personalPlans} />
        )}
      </div>

      {showAddUser && (
        <AddUserModal onClose={() => setShowAddUser(false)} onSave={async (u) => {
          await persist("ltp-users", (fresh) => [...fresh, u], setUsers);
          showToast(`${u.name} added`);
        }} />
      )}

      {showAddTraining && (
        <AddTrainingModal onClose={() => setShowAddTraining(false)} onSave={async (t) => {
          await persist("ltp-trainings", (fresh) => [...fresh, t], setTrainings);
          setShowAddTraining(false);
          showToast(`"${t.title}" created`);
        }} />
      )}

      {showEnroll && (
        <EnrollModal training={showEnroll} users={users.filter((u) => u.role === "learner")}
          onClose={() => setShowEnroll(null)}
          onSave={async (enrolledIds) => {
            await persist("ltp-trainings", (fresh) => fresh.map((t) => t.id === showEnroll.id ? { ...t, enrolled: enrolledIds } : t), setTrainings);
            setShowEnroll(null);
            showToast("Enrollment updated");
          }} />
      )}

      {showUpdate && (
        <UpdateProgressModal training={effectiveTrainingFor(showUpdate, currentUser.id, personalPlans)} currentUser={currentUser} progress={progress}
          onClose={() => setShowUpdate(null)}
          onSave={async (entry) => {
            await persist("ltp-progress", (fresh) => [...fresh, entry], setProgress);
            setShowUpdate(null);
            showToast("Progress logged");
          }}
          onSaveMany={async (newEntries, removeTopicIds, training) => {
            const touchedTopicIds = new Set([...removeTopicIds, ...newEntries.map((e) => e.topicId)]);
            await persist("ltp-progress", (fresh) =>
              [...fresh.filter((p) => !(p.trainingId === training.id && p.userId === currentUser.id && p.topicId && touchedTopicIds.has(p.topicId))), ...newEntries],
              setProgress);
            setShowUpdate(null);
            showToast("Learning plan checked");
          }} />
      )}

      {showAddTopic && (
        <AddTopicModal training={showAddTopic.training} onClose={() => setShowAddTopic(null)}
          onSave={async (newTopic) => {
            const { training, personalUserId } = showAddTopic;
            if (personalUserId) {
              await persist("ltp-personal-plans", (fresh) => {
                const pp = fresh.find((p) => p.trainingId === training.id && p.userId === personalUserId);
                return pp
                  ? fresh.map((p) => p.id === pp.id ? { ...p, lessonPlan: [...p.lessonPlan, newTopic] } : p)
                  : [...fresh, { id: uid(), trainingId: training.id, userId: personalUserId, lessonPlan: [newTopic], locked: false }];
              }, setPersonalPlans);
            } else {
              await persist("ltp-trainings", (fresh) =>
                fresh.map((t) => t.id === training.id ? { ...t, lessonPlan: [...(t.lessonPlan || []), newTopic] } : t),
                setTrainings);
            }
            setShowAddTopic(null);
            showToast("Topic added to lesson plan");
          }} />
      )}

      {showEditTopic && (
        <EditTopicModal training={showEditTopic.training} topic={showEditTopic.topic} onClose={() => setShowEditTopic(null)}
          onSave={async (updatedTopic) => {
            const { training, personalUserId } = showEditTopic;
            if (personalUserId) {
              await persist("ltp-personal-plans", (fresh) => {
                const pp = fresh.find((p) => p.trainingId === training.id && p.userId === personalUserId);
                if (!pp) return fresh;
                return fresh.map((p) =>
                  p.id === pp.id ? { ...p, lessonPlan: p.lessonPlan.map((l) => l.id === updatedTopic.id ? updatedTopic : l) } : p
                );
              }, setPersonalPlans);
            } else {
              await persist("ltp-trainings", (fresh) =>
                fresh.map((t) =>
                  t.id === training.id
                    ? { ...t, lessonPlan: t.lessonPlan.map((l) => l.id === updatedTopic.id ? updatedTopic : l) }
                    : t
                ), setTrainings);
            }
            setShowEditTopic(null);
            showToast("Topic updated");
          }} />
      )}

      {showCreatePlan && (
        <CreateLearningPlanModal training={showCreatePlan.training} willLock={showCreatePlan.willLock}
          onClose={() => setShowCreatePlan(null)}
          onSave={(topics) => handleCreatePlan(showCreatePlan.training, topics, showCreatePlan.willLock)} />
      )}

      {showCustomizePlan && (
        <CreateLearningPlanModal training={showCustomizePlan} willLock={true} mode="customize"
          initialTopics={showCustomizePlan.lessonPlan}
          onClose={() => setShowCustomizePlan(null)}
          onSave={(topics) => handleCustomizePlan(showCustomizePlan, topics)} />
      )}

      {showEditTraining && (
        <EditTrainingModal training={showEditTraining} onClose={() => setShowEditTraining(null)}
          onSave={async (updated) => {
            await persist("ltp-trainings", (fresh) => fresh.map((t) => t.id === updated.id ? updated : t), setTrainings);
            setShowEditTraining(null);
            showToast("Training updated");
          }} />
      )}

      {showCloneTraining && (
        <CloneTrainingModal training={showCloneTraining} onClose={() => setShowCloneTraining(null)}
          onSave={(newTitle, newStartDate, newEndDate) => handleCloneTraining(showCloneTraining, newTitle, newStartDate, newEndDate)} />
      )}

      {showReport && (
        <ReportModal trainings={trainings} users={users} progress={progress} personalPlans={personalPlans} onClose={() => setShowReport(false)} />
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: toast.isError ? T.delayedDim : T.onTrackDim,
          color: toast.isError ? T.delayed : T.onTrack,
          border: `1px solid ${toast.isError ? T.delayed : T.onTrack}44`,
          padding: "10px 18px", borderRadius: 8, fontFamily: T.sans, fontSize: 13.5, fontWeight: 600,
          zIndex: 60,
        }}>
          {toast.msg}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{
      minHeight: "100vh", background: T.bg, fontFamily: T.sans, color: T.ink,
      display: "flex", flexDirection: "column",
    }}>
      {children}
    </div>
  );
}

// ---------- Login ----------
function Login({ onSignIn, onSignUp, onForgotPassword, error }) {
  const [mode, setMode] = useState("signin"); // signin | signup | forgot
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [formError, setFormError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        await onSignIn(email.trim(), password);
      } else if (mode === "signup") {
        if (ALLOWED_EMAIL_DOMAIN && !email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
          throw new Error(`Please use your official @${ALLOWED_EMAIL_DOMAIN} email.`);
        }
        await onSignUp(email.trim(), password, name.trim());
        setNotice("Account created. Check your email to confirm it, then sign in.");
        setMode("signin");
      } else if (mode === "forgot") {
        await onForgotPassword(email.trim());
        setNotice("If that email has an account, a reset link is on its way.");
      }
    } catch (err) {
      setFormError(err.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 560, padding: 40 }}>
        <div style={{
          width: 52, height: 52, borderRadius: 12, background: T.brandDim,
          display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 18,
        }}>
          <BookOpen size={24} color={T.brand} />
        </div>
        <h1 style={{ fontFamily: T.serif, fontSize: 26, margin: "0 0 6px", textAlign: "center" }}>Techment - Learning Insights</h1>
        <p style={{ color: T.inkMuted, fontSize: 13, marginBottom: 24, textAlign: "center" }}>
          {mode === "signin" && "Sign in to track and update learning progress."}
          {mode === "signup" && "Create an account with your official email."}
          {mode === "forgot" && "Enter your email and we'll send a reset link."}
        </p>

        {(error || formError) && (
          <div style={{
            background: T.delayedDim, border: `1px solid ${T.delayed}44`, color: T.delayed,
            borderRadius: 8, padding: "10px 14px", fontSize: 12.5, marginBottom: 16, maxWidth: 340, width: "100%", boxSizing: "border-box",
          }}>{error || formError}</div>
        )}
        {notice && (
          <div style={{
            background: T.onTrackDim, border: `1px solid ${T.onTrack}44`, color: T.onTrack,
            borderRadius: 8, padding: "10px 14px", fontSize: 12.5, marginBottom: 16, maxWidth: 340, width: "100%", boxSizing: "border-box",
          }}>{notice}</div>
        )}

        <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 340 }}>
          {mode === "signup" && (
            <Field label="Full name">
              <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" required />
            </Field>
          )}
          <Field label="Email">
            <input type="email" style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
          </Field>
          {mode !== "forgot" && (
            <Field label="Password">
              <input type="password" style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={6} />
            </Field>
          )}

          {mode === "signin" && (
            <div style={{ textAlign: "right", marginBottom: 14, marginTop: -6 }}>
              <button type="button" onClick={() => { setMode("forgot"); setFormError(null); setNotice(null); }} style={{
                background: "none", border: "none", color: T.brand, fontSize: 12, cursor: "pointer", fontFamily: T.sans,
              }}>Forgot password?</button>
            </div>
          )}

          <Btn type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
          </Btn>
        </form>

        <div style={{ marginTop: 18, fontSize: 12.5, color: T.inkMuted }}>
          {mode === "signin" && (
            <span>New here? <button onClick={() => { setMode("signup"); setFormError(null); setNotice(null); }} style={{ background: "none", border: "none", color: T.brand, cursor: "pointer", fontFamily: T.sans, fontSize: 12.5 }}>Create an account</button></span>
          )}
          {(mode === "signup" || mode === "forgot") && (
            <span>Already have an account? <button onClick={() => { setMode("signin"); setFormError(null); setNotice(null); }} style={{ background: "none", border: "none", color: T.brand, cursor: "pointer", fontFamily: T.sans, fontSize: 12.5 }}>Sign in</button></span>
          )}
        </div>

        <p style={{ color: T.inkFaint, fontSize: 11, marginTop: 22, maxWidth: 300, textAlign: "center" }}>
          The first person to sign up becomes the workspace admin. Everyone after that starts as a learner.
        </p>
      </div>
    </Shell>
  );
}

function SetNewPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      await updatePassword(password);
      onDone();
    } catch (err) {
      setError(err.message || "Could not update password. The reset link may have expired.");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 560, padding: 40 }}>
        <h1 style={{ fontFamily: T.serif, fontSize: 24, margin: "0 0 6px", textAlign: "center" }}>Set a new password</h1>
        <p style={{ color: T.inkMuted, fontSize: 13, marginBottom: 24, textAlign: "center", maxWidth: 320 }}>
          Choose a new password for your account.
        </p>
        {error && (
          <div style={{
            background: T.delayedDim, border: `1px solid ${T.delayed}44`, color: T.delayed,
            borderRadius: 8, padding: "10px 14px", fontSize: 12.5, marginBottom: 16, maxWidth: 340, width: "100%", boxSizing: "border-box",
          }}>{error}</div>
        )}
        <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 340 }}>
          <Field label="New password">
            <input type="password" style={inputStyle} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={6} />
          </Field>
          <Field label="Confirm new password">
            <input type="password" style={inputStyle} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required minLength={6} />
          </Field>
          <Btn type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center", opacity: busy ? 0.7 : 1 }}>
            {busy ? "Saving…" : "Save new password"}
          </Btn>
        </form>
      </div>
    </Shell>
  );
}

// ---------- Admin Dashboard ----------
function AdminDashboard({ trainings, users, progress, alerts, personalPlans, onAddTraining, onEnroll, onAddTopic, onEditTopic, onDeleteTopic, onUnenroll, onCreatePlan, onEditTraining, onDeleteTraining, onCloneTraining }) {
  const learners = users.filter((u) => u.role === "learner");
  let onTrack = 0, delayedC = 0, inProgress = 0, completed = 0, notStarted = 0, total = 0;
  trainings.forEach((t) => t.enrolled.forEach((uid_) => {
    total++;
    const s = computeStatus(effectiveTrainingFor(t, uid_, personalPlans), uid_, progress).status;
    if (s === "On Track") onTrack++;
    else if (s === "Delayed") delayedC++;
    else if (s === "In Progress") inProgress++;
    else if (s === "Completed") completed++;
    else notStarted++;
  }));

  if (trainings.length === 0) {
    return <EmptyState
      title="No trainings yet"
      body="Add a training program with a start and end date, then enroll learners. Their planned pace will be calculated automatically."
      action={<Btn onClick={onAddTraining}><Plus size={15} /> Add a training</Btn>} />;
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 24 }}>
        <StatCard label="Enrollments" value={total} color={T.ink} />
        <StatCard label="On Track" value={onTrack} color={T.onTrack} />
        <StatCard label="In Progress" value={inProgress} color={T.progress} />
        <StatCard label="Delayed" value={delayedC} color={T.delayed} />
        <StatCard label="Completed" value={completed} color={T.brand} />
      </div>

      {alerts.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <SectionHeading icon={AlertTriangle} label="Needs attention" color={T.delayed} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {alerts.map((a, i) => (
              <div key={i} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                background: T.delayedDim, border: `1px solid ${T.delayed}33`, borderRadius: 9, padding: "10px 14px",
              }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{a.user?.name}</span>
                  <span style={{ color: T.inkMuted, fontSize: 13 }}> — {a.training.title}</span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 12.5, color: T.delayed }}>
                  {a.actualPct}% actual vs {a.plannedPct}% planned
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <SectionHeading icon={BookOpen} label="All trainings" />
        <Btn onClick={onAddTraining}><Plus size={14} /> New training</Btn>
      </div>
      {trainings.map((t) => (
        <TrainingCard key={t.id} training={t} users={users} progress={progress} personalPlans={personalPlans} onEnroll={() => onEnroll(t)}
          onAddTopic={(personalUserId) => onAddTopic(t, personalUserId)}
          onEditTopic={(topic, personalUserId) => onEditTopic(t, topic, personalUserId)}
          onDeleteTopic={(topic, personalUserId) => onDeleteTopic(t, topic, personalUserId)}
          onUnenroll={(u) => onUnenroll(t, u)}
          onCreatePlan={() => onCreatePlan(t)} onEditTraining={onEditTraining} onDeleteTraining={onDeleteTraining} onCloneTraining={onCloneTraining} />
      ))}
    </div>
  );
}

function SectionHeading({ icon: Icon, label, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
      <Icon size={14} color={color || T.inkMuted} />
      <span style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: 0.6, textTransform: "uppercase", color: color || T.inkMuted, fontWeight: 600 }}>
        {label}
      </span>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontFamily: T.mono, fontSize: 26, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: T.inkMuted, marginTop: 6, fontFamily: T.sans, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function TrainingCard({ training, users, progress, personalPlans, onEnroll, onAddTopic, onEditTopic, onDeleteTopic, onUnenroll, onCreatePlan, onEditTraining, onDeleteTraining, onCloneTraining }) {
  const enrolledUsers = users.filter((u) => training.enrolled.includes(u.id));
  const hasTopics = training.lessonPlan && training.lessonPlan.length > 0;
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 18, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div>
            <div style={{ fontFamily: T.serif, fontSize: 17 }}>{training.title}</div>
            <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.inkFaint, marginTop: 4 }}>
              {fmtDate(training.startDate)} → {fmtDate(training.endDate)}
              {training.planLockedByLearner && <span style={{ color: T.brand }}> · plan locked (learner-submitted)</span>}
            </div>
          </div>
          {onEditTraining && (
            <button onClick={() => onEditTraining(training)} title="Edit training" style={{ background: "none", border: "none", color: T.inkFaint, cursor: "pointer", padding: 3, display: "flex", marginTop: 1 }}>
              <Pencil size={13} />
            </button>
          )}
          {onCloneTraining && (
            <button onClick={() => onCloneTraining(training)} title="Clone this training for a different team" style={{ background: "none", border: "none", color: T.inkFaint, cursor: "pointer", padding: 3, display: "flex", marginTop: 1 }}>
              <Copy size={13} />
            </button>
          )}
          {onDeleteTraining && (
            <button onClick={() => onDeleteTraining(training)} title="Delete training" style={{ background: "none", border: "none", color: T.delayed, cursor: "pointer", padding: 3, display: "flex", marginTop: 1 }}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!hasTopics && onCreatePlan && <Btn variant="ghost" onClick={onCreatePlan}><ClipboardList size={13} /> Create learning plan</Btn>}
          {onAddTopic && <Btn variant="ghost" onClick={() => onAddTopic()}><Plus size={13} /> Add topic</Btn>}
          <Btn variant="ghost" onClick={onEnroll}><UserPlus size={13} /> Enroll ({enrolledUsers.length})</Btn>
        </div>
      </div>
      {training.lessonPlan && training.lessonPlan.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11.5, color: T.inkFaint, cursor: "pointer" }}>{training.lessonPlan.length} topics in shared plan</summary>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            {training.lessonPlan.map((l) => (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: T.inkMuted, padding: "3px 0" }}>
                <span>{l.topic}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: T.mono }}>{fmtDate(l.expectedDate)}</span>
                  {onEditTopic && (
                    <button onClick={() => onEditTopic(l)} title="Edit topic" style={{ background: "none", border: "none", color: T.inkFaint, cursor: "pointer", padding: 2, display: "flex" }}>
                      <Pencil size={12} />
                    </button>
                  )}
                  {onDeleteTopic && (
                    <button onClick={() => onDeleteTopic(l)} title="Delete topic" style={{ background: "none", border: "none", color: T.delayed, cursor: "pointer", padding: 2, display: "flex" }}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      {enrolledUsers.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {enrolledUsers.map((u) => {
            const personalPlan = getPersonalPlan(training, u.id, personalPlans);
            const isCustom = !!personalPlan;
            const s = computeStatus(effectiveTrainingFor(training, u.id, personalPlans), u.id, progress);
            return (
              <div key={u.id}>
                <div style={{ display: "grid", gridTemplateColumns: "110px 1fr auto auto", gap: 12, alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: T.inkMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.name}{isCustom && <span style={{ color: T.brand, fontSize: 10.5, marginLeft: 4 }}>●</span>}
                  </span>
                  <LedgerBar plannedPct={s.plannedPct} actualPct={s.actualPct} status={s.status} compact />
                  <StatusBadge status={s.status} />
                  {onUnenroll && (
                    <button onClick={() => onUnenroll(u)} title={`Remove ${u.name} from this training`} style={{
                      background: "none", border: "none", color: T.inkFaint, cursor: "pointer", padding: 2, display: "flex",
                    }}>
                      <UserMinus size={14} />
                    </button>
                  )}
                </div>
                {isCustom && (
                  <details style={{ marginTop: 4, marginLeft: 2 }}>
                    <summary style={{ fontSize: 11, color: T.brand, cursor: "pointer" }}>{u.name}'s custom plan ({personalPlan.lessonPlan.length} topics)</summary>
                    <div style={{ marginTop: 4, marginLeft: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                      {personalPlan.lessonPlan.map((l) => (
                        <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: T.inkMuted, padding: "2px 0" }}>
                          <span>{l.topic}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontFamily: T.mono }}>{fmtDate(l.expectedDate)}</span>
                            {onEditTopic && (
                              <button onClick={() => onEditTopic(l, u.id)} title="Edit topic" style={{ background: "none", border: "none", color: T.inkFaint, cursor: "pointer", padding: 2, display: "flex" }}>
                                <Pencil size={12} />
                              </button>
                            )}
                            {onDeleteTopic && (
                              <button onClick={() => onDeleteTopic(l, u.id)} title="Delete topic" style={{ background: "none", border: "none", color: T.delayed, cursor: "pointer", padding: 2, display: "flex" }}>
                                <Trash2 size={12} />
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrainingsView({ trainings, users, progress, personalPlans, onAdd, onEnroll, onAddTopic, onEditTopic, onDeleteTopic, onUnenroll, onCreatePlan, onEditTraining, onDeleteTraining, onCloneTraining }) {
  if (trainings.length === 0) {
    return <EmptyState title="No trainings yet" body="Create your first training program to start tracking progress."
      action={<Btn onClick={onAdd}><Plus size={15} /> Add a training</Btn>} />;
  }
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <Btn onClick={onAdd}><Plus size={14} /> New training</Btn>
      </div>
      {trainings.map((t) => (
        <TrainingCard key={t.id} training={t} users={users} progress={progress} personalPlans={personalPlans} onEnroll={() => onEnroll(t)}
          onAddTopic={(personalUserId) => onAddTopic(t, personalUserId)}
          onEditTopic={(topic, personalUserId) => onEditTopic(t, topic, personalUserId)}
          onDeleteTopic={(topic, personalUserId) => onDeleteTopic(t, topic, personalUserId)}
          onUnenroll={(u) => onUnenroll(t, u)}
          onCreatePlan={() => onCreatePlan(t)} onEditTraining={onEditTraining} onDeleteTraining={onDeleteTraining} onCloneTraining={onCloneTraining} />
      ))}
    </div>
  );
}

function UsersView({ users, trainings, onAdd, onChangeRole, onDeleteUser, currentUserId }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <Btn onClick={onAdd}><Plus size={14} /> Add user</Btn>
      </div>
      {users.length === 0 ? (
        <EmptyState title="No users yet" body="Add learners and admins to your workspace." action={<Btn onClick={onAdd}><Plus size={15} /> Add a user</Btn>} />
      ) : (
        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, overflow: "hidden" }}>
          {users.map((u, i) => {
            const enrolledCount = trainings.filter((t) => t.enrolled.includes(u.id)).length;
            const isSelf = u.id === currentUserId;
            return (
              <div key={u.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "13px 16px", borderBottom: i < users.length - 1 ? `1px solid ${T.line}` : "none",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: "50%", background: T.brandDim,
                    display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.serif, fontSize: 12, color: T.brand,
                  }}>{u.name.charAt(0).toUpperCase()}</span>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{u.name}</div>
                    <div style={{ fontSize: 11.5, color: T.inkFaint }}>{u.email || "no email on file"}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {u.role === "learner" && <span style={{ fontSize: 12, color: T.inkMuted, fontFamily: T.mono }}>{enrolledCount} enrolled</span>}
                  <button
                    onClick={() => !isSelf && onChangeRole(u, u.role === "admin" ? "learner" : "admin")}
                    disabled={isSelf}
                    title={isSelf ? "You can't change your own role" : `Make ${u.role === "admin" ? "learner" : "admin"}`}
                    style={{
                      fontFamily: T.mono, fontSize: 10.5, textTransform: "uppercase", color: u.role === "admin" ? T.brand : T.inkMuted,
                      border: `1px solid ${u.role === "admin" ? T.brand : T.line}`, borderRadius: 20, padding: "2px 9px",
                      background: "none", cursor: isSelf ? "default" : "pointer", opacity: isSelf ? 0.6 : 1,
                    }}>{u.role}</button>
                  {!isSelf && (
                    <button onClick={() => onDeleteUser(u)} title={`Delete ${u.name}`} style={{
                      background: "none", border: "none", color: T.delayed, cursor: "pointer", padding: 2, display: "flex",
                    }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STATUS_ORDER = ["Delayed", "In Progress", "Not Started", "On Track", "Completed"];

function ReportsView({ trainings, users, progress, personalPlans, onOpenReport }) {
  const learners = users.filter((u) => u.role === "learner");

  const allRows = useMemo(() => {
    const rows = [];
    trainings.forEach((t) => t.enrolled.forEach((uid_) => {
      const u = users.find((x) => x.id === uid_);
      const isCustom = !!getPersonalPlan(t, uid_, personalPlans);
      const s = computeStatus(effectiveTrainingFor(t, uid_, personalPlans), uid_, progress);
      rows.push({ trainingId: t.id, training: t.title, userId: uid_, user: u?.name || "—", isCustom, ...s });
    }));
    return rows;
  }, [trainings, users, progress, personalPlans]);

  const [trainingFilter, setTrainingFilter] = useState("all");
  const [learnerFilter, setLearnerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState(new Set(STATUS_ORDER));

  const toggleStatus = (s) => setStatusFilter((prev) => {
    const next = new Set(prev);
    next.has(s) ? next.delete(s) : next.add(s);
    return next;
  });

  const filtersActive = trainingFilter !== "all" || learnerFilter !== "all" || statusFilter.size !== STATUS_ORDER.length;
  const resetFilters = () => { setTrainingFilter("all"); setLearnerFilter("all"); setStatusFilter(new Set(STATUS_ORDER)); };

  const rows = allRows.filter((r) =>
    (trainingFilter === "all" || r.trainingId === trainingFilter) &&
    (learnerFilter === "all" || r.userId === learnerFilter) &&
    statusFilter.has(r.status)
  );

  const statusChartData = useMemo(() => {
    const counts = {};
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    return STATUS_ORDER.filter((s) => counts[s]).map((s) => ({ name: s, value: counts[s], color: STATUS_STYLE[s].color }));
  }, [rows]);

  const trainingChartData = useMemo(() => {
    const byTraining = {};
    rows.forEach((r) => {
      if (!byTraining[r.training]) byTraining[r.training] = { name: r.training, plannedTotal: 0, actualTotal: 0, count: 0 };
      byTraining[r.training].plannedTotal += r.plannedPct;
      byTraining[r.training].actualTotal += r.actualPct;
      byTraining[r.training].count += 1;
    });
    return Object.values(byTraining).map((t) => ({
      name: t.name.length > 18 ? t.name.slice(0, 17) + "…" : t.name,
      Planned: Math.round(t.plannedTotal / t.count),
      Actual: Math.round(t.actualTotal / t.count),
    }));
  }, [rows]);

  const selectStyle = { ...inputStyle, cursor: "pointer" };

  // --- Downloads ---
  const [dlTrainingId, setDlTrainingId] = useState(trainings[0]?.id || "");
  const [dlLearnerId, setDlLearnerId] = useState("");
  const dlTraining = trainings.find((t) => t.id === dlTrainingId);
  const dlTrainingLearners = dlTraining ? learners.filter((u) => dlTraining.enrolled.includes(u.id)) : [];
  const dlLearnerPlan = dlTraining && dlLearnerId ? effectiveLessonPlan(dlTraining, dlLearnerId, personalPlans) : [];

  function downloadStatusTable() {
    downloadCSV("status-report", rows.map((r) => ({
      Learner: r.user, Training: r.training, "Custom Plan": r.isCustom ? "Yes" : "No",
      "Target %": 100, "Planned % (pace)": r.plannedPct, "Actual %": r.actualPct, Status: r.status,
    })));
  }

  function downloadTrainingPlan() {
    if (!dlTraining || !dlTraining.lessonPlan?.length) return;
    downloadCSV(`${dlTraining.title}-lesson-plan`, dlTraining.lessonPlan.map((l) => ({
      Topic: l.topic, "Expected Date": l.expectedDate,
    })));
  }

  function downloadLearnerPlan() {
    if (!dlTraining || !dlLearnerId || !dlLearnerPlan.length) return;
    const learner = users.find((u) => u.id === dlLearnerId);
    downloadCSV(`${learner?.name || "learner"}-${dlTraining.title}-plan`, dlLearnerPlan.map((l) => {
      const entry = progress.find((p) => p.trainingId === dlTraining.id && p.userId === dlLearnerId && p.topicId === l.id);
      return {
        Topic: l.topic, "Expected Date": l.expectedDate,
        Completed: entry ? "Yes" : "No", "Completion Date": entry?.date || "", Note: entry?.note || "",
      };
    }));
  }

  return (
    <div>
      <div style={{
        background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 20,
        display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22, flexWrap: "wrap", gap: 12,
      }}>
        <div>
          <div style={{ fontFamily: T.serif, fontSize: 17 }}>Weekly progress report</div>
          <div style={{ fontSize: 12.5, color: T.inkMuted, marginTop: 4, maxWidth: 440 }}>
            Compile current status for every learner and send it to their inbox in one click.
          </div>
        </div>
        <Btn onClick={onOpenReport}><Mail size={14} /> Generate & email report</Btn>
      </div>

      {/* Downloads */}
      <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 16, marginBottom: 20 }}>
        <SectionHeading icon={FileText} label="Downloads (CSV — opens in Excel)" />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.line}` }}>
          <span style={{ fontSize: 12.5, color: T.inkMuted }}>Current filtered status table ({rows.length} rows)</span>
          <Btn variant="ghost" onClick={downloadStatusTable} style={{ opacity: rows.length ? 1 : 0.5 }}><Download size={13} /> Download</Btn>
        </div>

        <div style={{ padding: "12px 0", borderBottom: `1px solid ${T.line}` }}>
          <div style={{ fontSize: 12.5, color: T.inkMuted, marginBottom: 8 }}>
            A training's master lesson plan — topic list only, reusable to seed a new training later.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select style={{ ...selectStyle, flex: 1, minWidth: 180 }} value={dlTrainingId} onChange={(e) => setDlTrainingId(e.target.value)}>
              {trainings.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <Btn variant="ghost" onClick={downloadTrainingPlan} style={{ opacity: dlTraining?.lessonPlan?.length ? 1 : 0.5 }}>
              <Download size={13} /> Download plan
            </Btn>
          </div>
        </div>

        <div style={{ paddingTop: 12 }}>
          <div style={{ fontSize: 12.5, color: T.inkMuted, marginBottom: 8 }}>
            One learner's submitted plan — every topic, whether they completed it, and when.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select style={{ ...selectStyle, flex: 1, minWidth: 140 }} value={dlTrainingId} onChange={(e) => { setDlTrainingId(e.target.value); setDlLearnerId(""); }}>
              {trainings.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <select style={{ ...selectStyle, flex: 1, minWidth: 140 }} value={dlLearnerId} onChange={(e) => setDlLearnerId(e.target.value)}>
              <option value="">Select a learner…</option>
              {dlTrainingLearners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <Btn variant="ghost" onClick={downloadLearnerPlan} style={{ opacity: dlLearnerId && dlLearnerPlan.length ? 1 : 0.5 }}>
              <Download size={13} /> Download
            </Btn>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 16, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <SectionHeading icon={Filter} label="Filters" />
          {filtersActive && (
            <button onClick={resetFilters} style={{
              display: "flex", alignItems: "center", gap: 5, background: "none", border: "none",
              color: T.brand, fontSize: 12, cursor: "pointer", fontFamily: T.sans, fontWeight: 600,
            }}><RotateCcw size={12} /> Reset</button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 14 }}>
          <label>
            <div style={{ fontSize: 11.5, color: T.inkMuted, marginBottom: 5, fontFamily: T.sans, fontWeight: 600 }}>Training</div>
            <select style={selectStyle} value={trainingFilter} onChange={(e) => setTrainingFilter(e.target.value)}>
              <option value="all">All trainings</option>
              {trainings.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </label>
          <label>
            <div style={{ fontSize: 11.5, color: T.inkMuted, marginBottom: 5, fontFamily: T.sans, fontWeight: 600 }}>Learner</div>
            <select style={selectStyle} value={learnerFilter} onChange={(e) => setLearnerFilter(e.target.value)}>
              <option value="all">All learners</option>
              {learners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: T.inkMuted, marginBottom: 7, fontFamily: T.sans, fontWeight: 600 }}>Status</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {STATUS_ORDER.map((s) => {
              const active = statusFilter.has(s);
              const style = STATUS_STYLE[s];
              return (
                <button key={s} onClick={() => toggleStatus(s)} style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 20,
                  fontFamily: T.sans, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${active ? style.color : T.line}`,
                  background: active ? style.bg : "transparent",
                  color: active ? style.color : T.inkFaint,
                }}>{s}</button>
              );
            })}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No matching enrollments" body="Try widening your filters, or enroll learners into a training." />
      ) : (
        <>
          {/* Visuals */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 24 }}>
            <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 16 }}>
              <SectionHeading icon={TrendingUp} label="Status breakdown" />
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={statusChartData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                    {statusChartData.map((entry, i) => <Cell key={i} fill={entry.color} stroke={T.surface} strokeWidth={2} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: T.surfaceRaised, border: `1px solid ${T.line}`, borderRadius: 8, fontFamily: T.sans, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontFamily: T.sans, fontSize: 11.5, color: T.inkMuted }} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 16 }}>
              <SectionHeading icon={ClipboardList} label="Planned vs. actual by training" />
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={trainingChartData} margin={{ left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={T.line} vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: T.inkMuted, fontSize: 11, fontFamily: T.sans }} axisLine={{ stroke: T.line }} tickLine={false} />
                  <YAxis tick={{ fill: T.inkMuted, fontSize: 11, fontFamily: T.sans }} axisLine={false} tickLine={false} unit="%" />
                  <Tooltip contentStyle={{ background: T.surfaceRaised, border: `1px solid ${T.line}`, borderRadius: 8, fontFamily: T.sans, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontFamily: T.sans, fontSize: 11.5, color: T.inkMuted }} />
                  <Bar dataKey="Planned" fill={T.inkFaint} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Actual" fill={T.brand} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <SectionHeading icon={ClipboardList} label={`Status table (${rows.length})`} />
          <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, overflow: "hidden" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 70px 100px 90px 110px", gap: 8, padding: "10px 16px",
              borderBottom: `1px solid ${T.line}`, fontFamily: T.mono, fontSize: 10.5, color: T.inkFaint, textTransform: "uppercase",
            }}>
              <span>Learner</span><span>Training</span><span>Target</span><span>Planned (pace)</span><span>Actual</span><span>Status</span>
            </div>
            {rows.map((r, i) => (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 70px 100px 90px 110px", gap: 8, padding: "11px 16px", alignItems: "center",
                borderBottom: i < rows.length - 1 ? `1px solid ${T.line}` : "none", fontSize: 13,
              }}>
                <span>{r.user}{r.isCustom && <span style={{ color: T.brand, fontSize: 10.5, marginLeft: 4 }} title="Custom plan">●</span>}</span>
                <span style={{ color: T.inkMuted }}>{r.training}</span>
                <span style={{ fontFamily: T.mono, color: T.inkFaint }}>100%</span>
                <span style={{ fontFamily: T.mono }}>{r.plannedPct}%</span>
                <span style={{ fontFamily: T.mono }}>{r.actualPct}%</span>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LearnerReports({ trainings, progress, currentUser, personalPlans }) {
  const rows = useMemo(() =>
    trainings.map((t) => ({
      training: t.title, trainingId: t.id,
      isCustom: !!getPersonalPlan(t, currentUser.id, personalPlans),
      ...computeStatus(effectiveTrainingFor(t, currentUser.id, personalPlans), currentUser.id, progress),
    })),
    [trainings, progress, currentUser, personalPlans]
  );

  const counts = { "On Track": 0, "In Progress": 0, "Delayed": 0, "Completed": 0, "Not Started": 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

  const statusChartData = STATUS_ORDER.filter((s) => counts[s]).map((s) => ({ name: s, value: counts[s], color: STATUS_STYLE[s].color }));

  function downloadMyProgress() {
    downloadCSV("my-progress", rows.map((r) => ({
      Training: r.training, "Target %": 100, "Planned % (pace)": r.plannedPct, "Actual %": r.actualPct, Status: r.status,
    })));
  }

  if (trainings.length === 0) {
    return <EmptyState title="Nothing to report yet" body="Once you're enrolled in a training, your progress will show up here." />;
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginBottom: 22 }}>
        <StatCard label="Trainings" value={rows.length} color={T.ink} />
        <StatCard label="On Track" value={counts["On Track"]} color={T.onTrack} />
        <StatCard label="Delayed" value={counts["Delayed"]} color={T.delayed} />
        <StatCard label="Completed" value={counts["Completed"]} color={T.brand} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 24 }}>
        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 16 }}>
          <SectionHeading icon={TrendingUp} label="Your status breakdown" />
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={statusChartData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {statusChartData.map((entry, i) => <Cell key={i} fill={entry.color} stroke={T.surface} strokeWidth={2} />)}
              </Pie>
              <Tooltip contentStyle={{ background: T.surfaceRaised, border: `1px solid ${T.line}`, borderRadius: 8, fontFamily: T.sans, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontFamily: T.sans, fontSize: 11.5, color: T.inkMuted }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 16 }}>
          <SectionHeading icon={ClipboardList} label="Planned vs. actual" />
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={rows.map((r) => ({ name: r.training.length > 16 ? r.training.slice(0, 15) + "…" : r.training, Planned: r.plannedPct, Actual: r.actualPct }))} margin={{ left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.line} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: T.inkMuted, fontSize: 11, fontFamily: T.sans }} axisLine={{ stroke: T.line }} tickLine={false} />
              <YAxis tick={{ fill: T.inkMuted, fontSize: 11, fontFamily: T.sans }} axisLine={false} tickLine={false} unit="%" />
              <Tooltip contentStyle={{ background: T.surfaceRaised, border: `1px solid ${T.line}`, borderRadius: 8, fontFamily: T.sans, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontFamily: T.sans, fontSize: 11.5, color: T.inkMuted }} />
              <Bar dataKey="Planned" fill={T.inkFaint} radius={[4, 4, 0, 0]} />
              <Bar dataKey="Actual" fill={T.brand} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <SectionHeading icon={ClipboardList} label="Your trainings" />
        <Btn variant="ghost" onClick={downloadMyProgress}><Download size={13} /> Download (CSV)</Btn>
      </div>
      <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 70px 100px 90px 110px", gap: 8, padding: "10px 16px",
          borderBottom: `1px solid ${T.line}`, fontFamily: T.mono, fontSize: 10.5, color: T.inkFaint, textTransform: "uppercase",
        }}>
          <span>Training</span><span>Target</span><span>Planned (pace)</span><span>Actual</span><span>Status</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "1fr 70px 100px 90px 110px", gap: 8, padding: "11px 16px", alignItems: "center",
            borderBottom: i < rows.length - 1 ? `1px solid ${T.line}` : "none", fontSize: 13,
          }}>
            <span>{r.training}</span>
            <span style={{ fontFamily: T.mono, color: T.inkFaint }}>100%</span>
            <span style={{ fontFamily: T.mono }}>{r.plannedPct}%</span>
            <span style={{ fontFamily: T.mono }}>{r.actualPct}%</span>
            <StatusBadge status={r.status} />
          </div>
        ))}
      </div>
    </div>
  );
}


function LearnerDashboard({ trainings, progress, currentUser, personalPlans, onUpdate, onAddTopic, onEditTopic, onDeleteTopic, onCreatePlan, onSubmitPlan, onCustomizePlan, onRevertToSharedPlan }) {
  if (trainings.length === 0) {
    return <EmptyState title="Nothing assigned yet" body="Your admin hasn't enrolled you in a training. Check back soon." />;
  }
  return (
    <div>
      <SectionHeading icon={BookOpen} label={`${trainings.length} training${trainings.length > 1 ? "s" : ""} assigned to you`} />
      {trainings.map((t) => {
        const personalPlan = getPersonalPlan(t, currentUser.id, personalPlans);
        const isCustom = !!personalPlan;
        const effectivePlan = isCustom ? personalPlan.lessonPlan : (t.lessonPlan || []);
        const s = computeStatus({ ...t, lessonPlan: effectivePlan }, currentUser.id, progress);
        const hasTopics = effectivePlan.length > 0;
        const locked = isCustom ? !!personalPlan.locked : !!t.planLockedByLearner;
        const canManagePlan = !locked;
        const canCustomize = !isCustom && t.lessonPlan && t.lessonPlan.length > 0;
        const myCompletions = progress.filter((p) => p.trainingId === t.id && p.userId === currentUser.id && p.topicId);
        const doneById = new Map(myCompletions.map((p) => [p.topicId, p]));
        const myEntries = progress.filter((p) => p.trainingId === t.id && p.userId === currentUser.id && p.percent !== undefined)
          .sort((a, b) => (a.date < b.date ? 1 : -1));
        return (
          <div key={t.id} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 11, padding: 18, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontFamily: T.serif, fontSize: 17 }}>{t.title}</div>
                <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.inkFaint, marginTop: 4 }}>
                  {fmtDate(t.startDate)} → {fmtDate(t.endDate)}
                  {locked && <span style={{ color: T.brand }}> · plan locked</span>}
                  {isCustom && <span style={{ color: T.brand }}> · your custom plan</span>}
                </div>
              </div>
              <StatusBadge status={s.status} size="lg" />
            </div>
            {t.description && <p style={{ color: T.inkMuted, fontSize: 13, marginTop: 10, marginBottom: 14, lineHeight: 1.5 }}>{t.description}</p>}
            <LedgerBar plannedPct={s.plannedPct} actualPct={s.actualPct} status={s.status} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, flexWrap: "wrap", gap: 10 }}>
              <span style={{ fontSize: 11.5, color: T.inkFaint }}>
                {hasTopics
                  ? `${s.doneCount}/${s.totalTopics} topics done${s.overdueTopics?.length ? ` · ${s.overdueTopics.length} overdue` : ""}`
                  : s.lastUpdate ? `Last logged ${fmtDate(s.lastUpdate)}` : "No progress logged yet"}
              </span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {!hasTopics && <Btn variant="ghost" onClick={() => onCreatePlan(t)}><ClipboardList size={13} /> Create learning plan</Btn>}
                {canCustomize && <Btn variant="ghost" onClick={() => onCustomizePlan(t)}><Pencil size={13} /> Customize for yourself</Btn>}
                {isCustom && <Btn variant="ghost" onClick={() => onRevertToSharedPlan(t)}><RotateCcw size={13} /> Use shared plan instead</Btn>}
                {hasTopics && canManagePlan && (
                  <>
                    <Btn variant="ghost" onClick={() => onAddTopic(t, isCustom ? currentUser.id : undefined)}><Plus size={13} /> Add topic</Btn>
                    <Btn variant="ghost" onClick={() => onSubmitPlan(t)}><CheckCircle2 size={13} /> Submit plan</Btn>
                  </>
                )}
                <Btn onClick={() => onUpdate(t)}><Plus size={13} /> {hasTopics ? "Check Learning Plan" : "Log today's progress"}</Btn>
              </div>
            </div>

            {hasTopics && (
              <details style={{ marginTop: 12 }} open>
                <summary style={{ fontSize: 12, color: T.inkMuted, cursor: "pointer" }}>
                  {isCustom ? "Your lesson plan" : "Lesson plan"} ({effectivePlan.length} topics)
                </summary>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                  {effectivePlan.map((l) => {
                    const completion = doneById.get(l.id);
                    const done = !!completion;
                    const overdue = !done && l.expectedDate < todayISO();
                    return (
                      <div key={l.id} style={{ padding: "3px 0" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
                          <span style={{ color: done ? T.onTrack : overdue ? T.delayed : T.inkMuted, textDecoration: done ? "line-through" : "none" }}>
                            {done ? "✓ " : overdue ? "! " : "· "}{l.topic}
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontFamily: T.mono, color: T.inkFaint }}>
                              {done ? `done ${fmtDate(completion.date)}` : `due ${fmtDate(l.expectedDate)}`}
                            </span>
                            {canManagePlan && (
                              <>
                                <button onClick={() => onEditTopic(t, l, isCustom ? currentUser.id : undefined)} title="Edit topic" style={{ background: "none", border: "none", color: T.inkFaint, cursor: "pointer", padding: 2, display: "flex" }}>
                                  <Pencil size={12} />
                                </button>
                                <button onClick={() => onDeleteTopic(t, l, isCustom ? currentUser.id : undefined)} title="Delete topic" style={{ background: "none", border: "none", color: T.delayed, cursor: "pointer", padding: 2, display: "flex" }}>
                                  <Trash2 size={12} />
                                </button>
                              </>
                            )}
                          </span>
                        </div>
                        {done && completion.note && (
                          <div style={{ fontSize: 11.5, color: T.inkFaint, fontStyle: "italic", marginTop: 2, marginLeft: 14 }}>
                            “{completion.note}”
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            )}

            {!hasTopics && myEntries.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ fontSize: 12, color: T.inkMuted, cursor: "pointer" }}>History ({myEntries.length})</summary>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  {myEntries.map((e) => (
                    <div key={e.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: T.inkMuted }}>
                      <span style={{ fontFamily: T.mono }}>{fmtDate(e.date)}</span>
                      <span>{e.percent}%{e.note ? ` — ${e.note}` : ""}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ title, body, action }) {
  return (
    <div style={{
      textAlign: "center", padding: "60px 20px", border: `1px dashed ${T.line}`, borderRadius: 12,
    }}>
      <div style={{ fontFamily: T.serif, fontSize: 18, marginBottom: 8 }}>{title}</div>
      <p style={{ color: T.inkMuted, fontSize: 13.5, maxWidth: 380, margin: "0 auto 18px", lineHeight: 1.5 }}>{body}</p>
      {action}
    </div>
  );
}

// ---------- Modals ----------
function AddTopicModal({ training, onClose, onSave }) {
  const [topic, setTopic] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const outOfRange = expectedDate && (expectedDate < training.startDate || expectedDate > training.endDate);
  const valid = topic.trim() && expectedDate && !outOfRange;
  return (
    <Modal title={`Add a topic — ${training.title}`} onClose={onClose}>
      <Field label="Topic"><input style={inputStyle} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Error handling patterns" /></Field>
      <Field label="Expected completion date">
        <input type="date" style={inputStyle} value={expectedDate} min={training.startDate} max={training.endDate} onChange={(e) => setExpectedDate(e.target.value)} />
      </Field>
      {outOfRange && (
        <div style={{ color: T.delayed, fontSize: 12, marginBottom: 12, marginTop: -8 }}>
          Must fall within the training's dates: {fmtDate(training.startDate)} – {fmtDate(training.endDate)}.
        </div>
      )}
      <Btn style={{ width: "100%", justifyContent: "center", opacity: valid ? 1 : 0.5 }}
        onClick={() => valid && onSave({ id: uid(), topic: topic.trim(), expectedDate })}>
        Add topic
      </Btn>
    </Modal>
  );
}

function EditTopicModal({ training, topic, onClose, onSave }) {
  const [text, setText] = useState(topic.topic);
  const [expectedDate, setExpectedDate] = useState(topic.expectedDate);
  const outOfRange = expectedDate && (expectedDate < training.startDate || expectedDate > training.endDate);
  const valid = text.trim() && expectedDate && !outOfRange;
  return (
    <Modal title={`Edit topic — ${training.title}`} onClose={onClose}>
      <Field label="Topic"><input style={inputStyle} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="Expected completion date">
        <input type="date" style={inputStyle} value={expectedDate} min={training.startDate} max={training.endDate} onChange={(e) => setExpectedDate(e.target.value)} />
      </Field>
      {outOfRange && (
        <div style={{ color: T.delayed, fontSize: 12, marginBottom: 12, marginTop: -8 }}>
          Must fall within the training's dates: {fmtDate(training.startDate)} – {fmtDate(training.endDate)}.
        </div>
      )}
      <Btn style={{ width: "100%", justifyContent: "center", opacity: valid ? 1 : 0.5 }}
        onClick={() => valid && onSave({ ...topic, topic: text.trim(), expectedDate })}>
        Save changes
      </Btn>
    </Modal>
  );
}

function CreateLearningPlanModal({ training, willLock, initialTopics, mode, onClose, onSave }) {
  const [lessons, setLessons] = useState(() =>
    initialTopics && initialTopics.length
      ? initialTopics.map((l) => ({ id: uid(), topic: l.topic, expectedDate: l.expectedDate }))
      : [{ id: uid(), topic: "", expectedDate: "" }]
  );

  const updateLesson = (id, field, value) =>
    setLessons((ls) => ls.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
  const addLesson = () => setLessons((ls) => [...ls, { id: uid(), topic: "", expectedDate: "" }]);
  const removeLesson = (id) => setLessons((ls) => ls.length > 1 ? ls.filter((l) => l.id !== id) : ls);

  const isOutOfRange = (l) => l.expectedDate && (l.expectedDate < training.startDate || l.expectedDate > training.endDate);
  const cleanLessons = lessons.filter((l) => l.topic.trim() && l.expectedDate);
  const anyOutOfRange = cleanLessons.some(isOutOfRange);
  const valid = cleanLessons.length > 0 && !anyOutOfRange;
  const isCustomize = mode === "customize";

  return (
    <Modal title={isCustomize ? `Customize your plan — ${training.title}` : `Create learning plan — ${training.title}`} onClose={onClose} wide>
      <p style={{ fontSize: 12.5, color: T.inkMuted, marginBottom: 6, lineHeight: 1.5 }}>
        {isCustomize
          ? "This starts as a copy of the admin's shared plan — edit, add, or remove topics freely before submitting. Once submitted, it's yours alone: other learners keep following the shared plan untouched, and only an admin can edit yours after this."
          : <>Add every topic you plan to cover, each with an expected completion date between {fmtDate(training.startDate)} and {fmtDate(training.endDate)}.</>}
        {!isCustomize && (willLock
          ? " Once you submit, this list is locked — only an admin can edit or delete topics after that. You can still check off topics and log completion dates any time."
          : " You can edit or delete any of these later.")}
      </p>
      {isCustomize && (
        <p style={{ fontSize: 11.5, color: T.inkFaint, marginBottom: 6 }}>
          Dates must fall between {fmtDate(training.startDate)} and {fmtDate(training.endDate)}.
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10, marginTop: 12 }}>
        {lessons.map((l, i) => {
          const outOfRange = isOutOfRange(l);
          return (
            <div key={l.id}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 32px", gap: 8, alignItems: "center" }}>
                <input style={inputStyle} value={l.topic} onChange={(e) => updateLesson(l.id, "topic", e.target.value)}
                  placeholder={`Topic ${i + 1}, e.g. Pivot tables`} />
                <input type="date" style={{ ...inputStyle, borderColor: outOfRange ? T.delayed : T.line }}
                  value={l.expectedDate} min={training.startDate} max={training.endDate}
                  onChange={(e) => updateLesson(l.id, "expectedDate", e.target.value)} />
                <button onClick={() => removeLesson(l.id)} style={{
                  background: "none", border: `1px solid ${T.line}`, borderRadius: 6, color: T.inkFaint,
                  cursor: "pointer", height: 34, display: "flex", alignItems: "center", justifyContent: "center",
                }}><X size={13} /></button>
              </div>
              {outOfRange && (
                <div style={{ color: T.delayed, fontSize: 11.5, marginTop: 4 }}>
                  Outside the training's dates ({fmtDate(training.startDate)} – {fmtDate(training.endDate)}).
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button onClick={addLesson} style={{
        background: "none", border: "none", color: T.brand, fontSize: 12.5, cursor: "pointer",
        fontFamily: T.sans, fontWeight: 600, display: "flex", alignItems: "center", gap: 4, marginBottom: 18, padding: 0,
      }}><Plus size={13} /> Add another topic</button>

      <Btn style={{ width: "100%", justifyContent: "center", opacity: valid ? 1 : 0.5 }}
        onClick={() => valid && onSave(cleanLessons.map((l) => ({ id: l.id, topic: l.topic.trim(), expectedDate: l.expectedDate })))}>
        {isCustomize ? "Submit my custom plan" : willLock ? "Submit plan" : "Save plan"}
      </Btn>
    </Modal>
  );
}


function AddUserModal({ onClose, onSave }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("learner");
  const [saved, setSaved] = useState(null);
  const [inviteStatus, setInviteStatus] = useState(null); // null | "sending" | "sent" | "failed"
  const [inviteError, setInviteError] = useState(null);

  async function handleAdd() {
    if (!name.trim() || !email.trim()) return;
    const user = { id: uid(), name: name.trim(), email: email.trim(), role };
    await onSave(user);
    setSaved(user);
    setInviteStatus("sending");
    try {
      await inviteUser(user.email, user.name, window.location.origin + window.location.pathname);
      setInviteStatus("sent");
    } catch (e) {
      console.error(e);
      setInviteError(e.message || "Could not send the invite.");
      setInviteStatus("failed");
    }
  }

  if (saved) {
    const appUrl = window.location.href;
    const subject = "You've been added to Techment - Learning Insights";
    const body =
`Hi ${saved.name},

You've been added to Techment - Learning Insights to track training progress.

To get started, go to ${appUrl} and sign up using this email address (${saved.email}) and a password of your choice. Once you sign up, you'll see your enrolled trainings automatically.

Thanks!`;
    const mailto = `mailto:${saved.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    return (
      <Modal title="User added" onClose={onClose}>
        <div style={{
          background: T.onTrackDim, border: `1px solid ${T.onTrack}44`, color: T.onTrack,
          borderRadius: 8, padding: "10px 14px", fontSize: 12.5, marginBottom: 14,
        }}>
          {saved.name} was added as a {saved.role}.
        </div>

        {inviteStatus === "sending" && (
          <p style={{ fontSize: 12.5, color: T.inkMuted, marginBottom: 16 }}>Sending them an invite email…</p>
        )}

        {inviteStatus === "sent" && (
          <div style={{
            background: T.brandDim, border: `1px solid ${T.brand}44`, color: T.brand,
            borderRadius: 8, padding: "10px 14px", fontSize: 12.5, marginBottom: 16,
          }}>
            Invite email sent to {saved.email}. They can click the link in it to set a password and log straight in.
          </div>
        )}

        {inviteStatus === "failed" && (
          <>
            <div style={{
              background: T.delayedDim, border: `1px solid ${T.delayed}44`, color: T.delayed,
              borderRadius: 8, padding: "10px 14px", fontSize: 12, marginBottom: 10,
            }}>
              Couldn't send the automatic invite ({inviteError}). This usually means the invite-user function isn't deployed yet — see the README.
            </div>
            <p style={{ fontSize: 12.5, color: T.inkMuted, marginBottom: 16 }}>
              You can send them a manual note instead for now:
            </p>
          </>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>Done</Btn>
          {inviteStatus === "failed" && (
            <a href={mailto} style={{ flex: 1, textDecoration: "none" }}>
              <Btn onClick={onClose} style={{ width: "100%", justifyContent: "center" }}><Mail size={14} /> Email invite manually</Btn>
            </a>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add a user" onClose={onClose}>
      <Field label="Full name"><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rahul Verma" /></Field>
      <Field label="Email"><input style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rahul@company.com" /></Field>
      <Field label="Role">
        <div style={{ display: "flex", gap: 8 }}>
          {["learner", "admin"].map((r) => (
            <button key={r} onClick={() => setRole(r)} style={{
              flex: 1, padding: "9px 0", borderRadius: 7, cursor: "pointer",
              border: `1px solid ${role === r ? T.brand : T.line}`,
              background: role === r ? T.brandDim : "transparent",
              color: role === r ? T.brand : T.inkMuted, fontFamily: T.sans, fontWeight: 600, fontSize: 13, textTransform: "capitalize",
            }}>{r}</button>
          ))}
        </div>
      </Field>
      {role === "admin" && (
        <p style={{ fontSize: 11, color: T.inkFaint, marginTop: -10, marginBottom: 16 }}>
          For security, admin access only takes effect after they sign up — then confirm it by toggling their role in this Users list once, so the database can verify it too.
        </p>
      )}
      <Btn style={{ width: "100%", justifyContent: "center", marginTop: 4 }} onClick={handleAdd}>
        Add user
      </Btn>
    </Modal>
  );
}

function AddTrainingModal({ onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState("");
  const [lessons, setLessons] = useState([{ id: uid(), topic: "", expectedDate: "" }]);

  const updateLesson = (id, field, value) =>
    setLessons((ls) => ls.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
  const addLesson = () => setLessons((ls) => [...ls, { id: uid(), topic: "", expectedDate: "" }]);
  const removeLesson = (id) => setLessons((ls) => ls.length > 1 ? ls.filter((l) => l.id !== id) : ls);

  const isOutOfRange = (l) => l.expectedDate && startDate && endDate && (l.expectedDate < startDate || l.expectedDate > endDate);
  const cleanLessons = lessons.filter((l) => l.topic.trim() && l.expectedDate);
  const anyOutOfRange = cleanLessons.some(isOutOfRange);
  const valid = title.trim() && startDate && endDate && endDate >= startDate && !anyOutOfRange;

  function handleSave() {
    if (!valid) return;
    onSave({
      id: uid(), title: title.trim(), description: description.trim(),
      startDate, endDate,
      lessonPlan: cleanLessons.map((l) => ({ id: l.id, topic: l.topic.trim(), expectedDate: l.expectedDate })),
      enrolled: [],
    });
  }

  return (
    <Modal title="New training" onClose={onClose} wide>
      <Field label="Title"><input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Advanced Excel for Analysts" /></Field>
      <Field label="Description (optional)">
        <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical", fontFamily: T.sans }}
          value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this training covers" />
      </Field>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}><Field label="Start date"><input type="date" style={inputStyle} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="End date"><input type="date" style={inputStyle} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field></div>
      </div>
      {endDate && endDate < startDate && <div style={{ color: T.delayed, fontSize: 12, marginBottom: 10, marginTop: -8 }}>End date must be on or after the start date.</div>}

      <div style={{ fontSize: 12, color: T.inkMuted, marginBottom: 8, fontFamily: T.sans, fontWeight: 600, letterSpacing: 0.3 }}>
        Lesson plan — topic and expected completion date (optional here — you or the learner can add the full plan later)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
        {lessons.map((l, i) => {
          const outOfRange = isOutOfRange(l);
          return (
            <div key={l.id}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 32px", gap: 8, alignItems: "center" }}>
                <input style={inputStyle} value={l.topic} onChange={(e) => updateLesson(l.id, "topic", e.target.value)}
                  placeholder={`Topic ${i + 1}, e.g. Pivot tables`} />
                <input type="date" style={{ ...inputStyle, borderColor: outOfRange ? T.delayed : T.line }}
                  value={l.expectedDate} min={startDate || undefined} max={endDate || undefined}
                  onChange={(e) => updateLesson(l.id, "expectedDate", e.target.value)} />
                <button onClick={() => removeLesson(l.id)} style={{
                  background: "none", border: `1px solid ${T.line}`, borderRadius: 6, color: T.inkFaint,
                  cursor: "pointer", height: 34, display: "flex", alignItems: "center", justifyContent: "center",
                }}><X size={13} /></button>
              </div>
              {outOfRange && (
                <div style={{ color: T.delayed, fontSize: 11.5, marginTop: 4 }}>Outside the training's start/end dates.</div>
              )}
            </div>
          );
        })}
      </div>
      <button onClick={addLesson} style={{
        background: "none", border: "none", color: T.brand, fontSize: 12.5, cursor: "pointer",
        fontFamily: T.sans, fontWeight: 600, display: "flex", alignItems: "center", gap: 4, marginBottom: 18, padding: 0,
      }}><Plus size={13} /> Add another topic</button>

      <Btn style={{ width: "100%", justifyContent: "center", opacity: valid ? 1 : 0.5 }} onClick={handleSave}>
        Create training
      </Btn>
    </Modal>
  );
}

function EditTrainingModal({ training, onClose, onSave }) {
  const [title, setTitle] = useState(training.title);
  const [description, setDescription] = useState(training.description || "");
  const [startDate, setStartDate] = useState(training.startDate);
  const [endDate, setEndDate] = useState(training.endDate);
  const valid = title.trim() && startDate && endDate && endDate >= startDate;

  return (
    <Modal title={`Edit training — ${training.title}`} onClose={onClose}>
      <Field label="Title"><input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Description (optional)">
        <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical", fontFamily: T.sans }}
          value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}><Field label="Start date"><input type="date" style={inputStyle} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="End date"><input type="date" style={inputStyle} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field></div>
      </div>
      {endDate && endDate < startDate && <div style={{ color: T.delayed, fontSize: 12, marginBottom: 10, marginTop: -8 }}>End date must be on or after the start date.</div>}
      <p style={{ fontSize: 11.5, color: T.inkFaint, marginBottom: 16 }}>
        Existing lesson plan topics aren't affected by changing these dates — edit or remove individual topics separately if needed.
      </p>
      <Btn style={{ width: "100%", justifyContent: "center", opacity: valid ? 1 : 0.5 }}
        onClick={() => valid && onSave({ ...training, title: title.trim(), description: description.trim(), startDate, endDate })}>
        Save changes
      </Btn>
    </Modal>
  );
}

function CloneTrainingModal({ training, onClose, onSave }) {
  const [title, setTitle] = useState(`${training.title} (Copy)`);
  const originalDuration = daysBetween(training.startDate, training.endDate);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const topicCount = training.lessonPlan?.length || 0;

  // Once a start date is picked, suggest an end date matching the original duration.
  const handleStartDate = (val) => {
    setStartDate(val);
    if (val && !endDate) setEndDate(addDays(val, originalDuration));
  };

  const valid = title.trim() && startDate && endDate && endDate >= startDate;
  const newDuration = startDate && endDate ? daysBetween(startDate, endDate) : null;
  const shorterWindow = newDuration !== null && newDuration < originalDuration;

  return (
    <Modal title={`Clone training — ${training.title}`} onClose={onClose}>
      <p style={{ fontSize: 12.5, color: T.inkMuted, marginBottom: 16, lineHeight: 1.5 }}>
        Creates a brand-new training with {topicCount > 0 ? `all ${topicCount} topics from the lesson plan, ` : ""}
        no enrollments and no progress — ready to assign to a different team on its own timeline.
        {topicCount > 0 && " Topic dates shift to match the new start date, keeping the same spacing between them."}
      </p>
      <Field label="Title"><input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}><Field label="New start date"><input type="date" style={inputStyle} value={startDate} onChange={(e) => handleStartDate(e.target.value)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="New end date"><input type="date" style={inputStyle} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field></div>
      </div>
      {endDate && startDate && endDate < startDate && <div style={{ color: T.delayed, fontSize: 12, marginBottom: 10, marginTop: -8 }}>End date must be on or after the start date.</div>}
      {shorterWindow && topicCount > 0 && (
        <div style={{ color: T.progress, fontSize: 11.5, marginBottom: 12, marginTop: -8 }}>
          This window is shorter than the original ({originalDuration} days) — some topic dates may get pulled in to fit.
        </div>
      )}
      <Btn style={{ width: "100%", justifyContent: "center", opacity: valid ? 1 : 0.5, marginTop: 4 }}
        onClick={() => valid && onSave(title.trim(), startDate, endDate)}>
        Create clone
      </Btn>
    </Modal>
  );
}


function EnrollModal({ training, users, onClose, onSave }) {
  const [selected, setSelected] = useState(training.enrolled);
  const toggle = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  return (
    <Modal title={`Enroll learners — ${training.title}`} onClose={onClose}>
      {users.length === 0 ? (
        <p style={{ color: T.inkMuted, fontSize: 13.5 }}>No learner accounts yet. Add users first.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {users.map((u) => (
            <label key={u.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 11px",
              borderRadius: 7, border: `1px solid ${T.line}`, cursor: "pointer",
              background: selected.includes(u.id) ? T.brandDim : "transparent",
            }}>
              <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
              <span style={{ fontSize: 13.5 }}>{u.name}</span>
            </label>
          ))}
        </div>
      )}
      <Btn style={{ width: "100%", justifyContent: "center" }} onClick={() => onSave(selected)}>Save enrollment</Btn>
    </Modal>
  );
}

function UpdateProgressModal({ training, currentUser, progress, onClose, onSave, onSaveMany }) {
  if (training.lessonPlan && training.lessonPlan.length > 0) {
    return <TopicChecklistModal training={training} currentUser={currentUser} progress={progress} onClose={onClose} onSaveMany={onSaveMany} />;
  }
  // Legacy percent-slider fallback
  const existing = progress.find((p) => p.trainingId === training.id && p.userId === currentUser.id && p.date === todayISO());
  const [percent, setPercent] = useState(existing?.percent ?? computeStatus(training, currentUser.id, progress).actualPct);
  const [note, setNote] = useState("");
  return (
    <Modal title={`Log progress — ${training.title}`} onClose={onClose}>
      <Field label={`Overall completion: ${percent}%`}>
        <input type="range" min={0} max={100} value={percent} onChange={(e) => setPercent(Number(e.target.value))} style={{ width: "100%" }} />
      </Field>
      <Field label="Note (optional)">
        <input style={inputStyle} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you cover today?" />
      </Field>
      <Btn style={{ width: "100%", justifyContent: "center", marginTop: 4 }}
        onClick={() => onSave({ id: uid(), trainingId: training.id, userId: currentUser.id, date: todayISO(), percent, note: note.trim() })}>
        Save today's update
      </Btn>
    </Modal>
  );
}

function TopicChecklistModal({ training, currentUser, progress, onClose, onSaveMany }) {
  const existingByTopic = new Map(
    progress.filter((p) => p.trainingId === training.id && p.userId === currentUser.id && p.topicId).map((p) => [p.topicId, p])
  );
  const today = todayISO();

  const [rows, setRows] = useState(() =>
    training.lessonPlan.map((l) => {
      const ex = existingByTopic.get(l.id);
      return { topicId: l.id, checked: !!ex, date: ex ? ex.date : today };
    })
  );
  const [note, setNote] = useState("");

  const toggle = (topicId) => setRows((rs) => rs.map((r) =>
    r.topicId === topicId ? { ...r, checked: !r.checked, date: r.date || today } : r
  ));
  const setRowDate = (topicId, date) => setRows((rs) => rs.map((r) => r.topicId === topicId ? { ...r, date } : r));

  const touchedCount = rows.filter((r) => {
    const ex = existingByTopic.get(r.topicId);
    return r.checked !== !!ex || (r.checked && ex && r.date !== ex.date);
  }).length;

  const futureDateRows = rows.filter((r) => r.checked && r.date > today);
  const canSave = futureDateRows.length === 0;

  function handleSave() {
    if (!canSave) return;
    const newEntries = [];
    const removeTopicIds = [];
    rows.forEach((r) => {
      const ex = existingByTopic.get(r.topicId);
      if (r.checked) {
        const changed = !ex || ex.date !== r.date;
        newEntries.push({
          id: ex ? ex.id : uid(),
          trainingId: training.id, userId: currentUser.id, topicId: r.topicId,
          date: r.date || today,
          note: (note.trim() || (changed ? undefined : ex?.note)) || undefined,
        });
      } else if (ex) {
        removeTopicIds.push(r.topicId);
      }
    });
    onSaveMany(newEntries, removeTopicIds, training);
  }

  return (
    <Modal title={`Check Learning Plan — ${training.title}`} onClose={onClose} wide>
      <p style={{ fontSize: 12.5, color: T.inkMuted, marginBottom: 14 }}>
        Check off any topic you've completed — in any order — and set the date you finished it (today or earlier only). Uncheck to undo, or just change the date if you logged it wrong.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
        {training.lessonPlan.map((l) => {
          const row = rows.find((r) => r.topicId === l.id);
          const overdue = l.expectedDate < today && !row.checked;
          const futureDate = row.checked && row.date > today;
          return (
            <div key={l.id}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
                padding: "10px 12px", borderRadius: 7,
                border: `1px solid ${futureDate ? T.delayed : overdue ? T.delayed + "55" : T.line}`,
                background: row.checked ? T.onTrackDim : overdue ? T.delayedDim : "transparent",
              }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" checked={row.checked} onChange={() => toggle(l.id)} />
                  <span style={{ fontSize: 13.5, textDecoration: row.checked ? "line-through" : "none", color: row.checked ? T.inkMuted : T.ink }}>
                    {l.topic}
                  </span>
                </label>
                {row.checked ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, color: T.inkFaint, fontFamily: T.sans }}>completed</span>
                    <input type="date" value={row.date} max={today} onChange={(e) => setRowDate(l.id, e.target.value)}
                      style={{ ...inputStyle, padding: "5px 8px", fontSize: 12, width: 140, borderColor: futureDate ? T.delayed : T.line }} />
                  </span>
                ) : (
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: overdue ? T.delayed : T.inkFaint }}>
                    due {fmtDate(l.expectedDate)}
                  </span>
                )}
              </div>
              {futureDate && (
                <div style={{ color: T.delayed, fontSize: 11.5, marginTop: 4 }}>
                  Completion date can't be in the future — pick today or an earlier date.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {touchedCount > 0 && (
        <Field label="Note (optional)">
          <textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical", fontFamily: T.sans }}
            value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you cover, or anything worth flagging?" />
        </Field>
      )}

      <Btn style={{ width: "100%", justifyContent: "center", opacity: canSave ? 1 : 0.5 }} onClick={handleSave}>Save update</Btn>
    </Modal>
  );
}

function ReportModal({ trainings, users, progress, personalPlans, onClose }) {
  const learners = users.filter((u) => u.role === "learner" && u.email);
  const learnersNoEmail = users.filter((u) => u.role === "learner" && !u.email);

  function buildReportText() {
    const lines = [`Weekly Learning Progress Report — ${fmtDate(todayISO())}`, ""];
    trainings.forEach((t) => {
      if (t.enrolled.length === 0) return;
      lines.push(`${t.title} (${fmtDate(t.startDate)} → ${fmtDate(t.endDate)})`);
      t.enrolled.forEach((uidx) => {
        const u = users.find((x) => x.id === uidx);
        const isCustom = !!getPersonalPlan(t, uidx, personalPlans);
        const s = computeStatus(effectiveTrainingFor(t, uidx, personalPlans), uidx, progress);
        lines.push(`  - ${u?.name || "Unknown"}: ${s.actualPct}% actual vs ${s.plannedPct}% planned — ${s.status}${isCustom ? " (custom plan)" : ""}`);
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  const body = buildReportText();
  const mailtoAll = `mailto:${learners.map((l) => l.email).join(",")}?subject=${encodeURIComponent("Weekly Learning Progress Report")}&body=${encodeURIComponent(body)}`;

  return (
    <Modal title="Weekly report" onClose={onClose} wide>
      <p style={{ fontSize: 12.5, color: T.inkMuted, lineHeight: 1.5, marginBottom: 14 }}>
        This opens your email app with the report pre-filled, addressed to every learner with an email on file.
        Fully automatic scheduled sending needs a backend or email integration, which isn't available inside this artifact.
      </p>
      <pre style={{
        background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: 14,
        fontFamily: T.mono, fontSize: 11.5, color: T.ink, whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto",
      }}>{body}</pre>
      {learnersNoEmail.length > 0 && (
        <div style={{ fontSize: 11.5, color: T.progress, marginTop: 8 }}>
          {learnersNoEmail.length} learner(s) have no email on file and won't receive this: {learnersNoEmail.map((u) => u.name).join(", ")}.
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" onClick={() => { navigator.clipboard?.writeText(body); onClose(); }}>Copy text</Btn>
        <a href={mailtoAll} style={{ flex: 1, textDecoration: "none" }}>
          <Btn style={{ width: "100%", justifyContent: "center" }}><Mail size={14} /> Open in email app</Btn>
        </a>
      </div>
    </Modal>
  );
}
