import { createClient } from '@supabase/supabase-js';

/**
 * Browser-side Supabase client.
 * Uses VITE_ prefixed env vars so Vite bundles them into the renderer safely.
 * Never expose the service-role key here — anon key only.
 */
const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL  as string;
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    '[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not set.\n' +
    'Copy .env.example → .env and fill in your values.'
  );
}

export const supabase = createClient(
  supabaseUrl  ?? 'http://localhost:54321',
  supabaseKey  ?? 'placeholder',
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  }
);
