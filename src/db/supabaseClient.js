const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('[supabase] SUPABASE_URL or SUPABASE_ANON_KEY not set — DB operations will fail.');
}

const supabase = createClient(
  supabaseUrl ?? 'http://localhost:54321',
  supabaseKey ?? 'placeholder',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

module.exports = { supabase };
