/* Date helpers for tests: always relative to the organisation's current day, so tests never depend on a fixed calendar. */
import {todayIn,addDays} from '../../supabase/functions/_shared/tools/normalise.js';
export const addDaysFromToday=n=>addDays(todayIn('UTC'),n);
export {todayIn};
