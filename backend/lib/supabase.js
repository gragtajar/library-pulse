// @ts-check
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  // Fail at module load — better to crash a cold start with a clear error
  // than handle every query path with `if (!supabase)`.
  throw new Error(
    "Supabase env vars missing: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
  );
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export default supabase;
