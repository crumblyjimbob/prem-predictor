import { supabase } from "./supabase";

/*
  The app talks to persistence only through `window.storage`, a key-value API
  that originally lived inside Claude artifacts. This shim re-implements that
  exact surface on top of a single Supabase table so the app is untouched.

  window.storage API (all keys are opaque strings, values are JSON strings):
    get(key, shared)    -> { value } on hit, null on miss
    set(key, val, shared) -> truthy on success, throws on failure
    list(prefix, shared) -> { keys: [...] }
    delete(key, shared)  -> void

  `shared` splits two namespaces: shared=true is the league data everyone sees;
  shared=false is per-device (only used to clear stale sign-ins). Both live in
  the same table, separated by the `shared` column.

  Table `kv`:
    key    text     not null
    shared boolean  not null default true
    value  text     not null
    primary key (key, shared)
*/

const TABLE = "kv";

export const storage = {
  async get(key, shared = false) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("value")
      .eq("key", key)
      .eq("shared", shared)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { value: data.value } : null;
  },

  async set(key, value, shared = false) {
    const { error } = await supabase
      .from(TABLE)
      .upsert({ key, shared, value }, { onConflict: "key,shared" });
    if (error) throw new Error(error.message);
    return true;
  },

  async list(prefix, shared = false) {
    // Escape LIKE wildcards in the prefix so keys with % or _ match literally.
    const safe = String(prefix).replace(/[%_\\]/g, (c) => "\\" + c);
    const { data, error } = await supabase
      .from(TABLE)
      .select("key")
      .eq("shared", shared)
      .like("key", `${safe}%`);
    if (error) throw new Error(error.message);
    return { keys: (data || []).map((r) => r.key) };
  },

  async delete(key, shared = false) {
    const { error } = await supabase
      .from(TABLE)
      .delete()
      .eq("key", key)
      .eq("shared", shared);
    if (error) throw new Error(error.message);
  },
};
