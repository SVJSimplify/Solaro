-- Trigger functions are never called through the API (triggers run without EXECUTE checks).
revoke execute on function alert_hands_off(), booking_names_chat(), kb_guard_managed(), messages_closed_guard(), sync_hours_answer(), touch_clinic_info() from authenticated;
-- Pin search_path on helper functions.
alter function hhmm_min(text) set search_path=public;
alter function hours_text(jsonb) set search_path=public;
alter function check_supersedes_same_org() set search_path=public;
alter function booking_label(bookings) set search_path=public;
alter function valid_hours(jsonb) set search_path=public;
alter function fmt_hm(text) set search_path=public;
alter function widget_origin_valid(text) set search_path=public;
