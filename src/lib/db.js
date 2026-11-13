/* Picks the backend. Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in .env to go live;
   without them the app runs fully in the browser (localStorage) for demos and development. */
import {local} from './localdb';
import {remote} from './supabasedb';
export const db=import.meta.env.VITE_SUPABASE_URL?remote:local;
export const isLive=!!import.meta.env.VITE_SUPABASE_URL;
