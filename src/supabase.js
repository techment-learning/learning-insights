import { createClient } from "@supabase/supabase-js";

// Values come from environment variables set in .env.local (dev) or
// GitHub Actions secrets (production build). See README.md for setup.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
