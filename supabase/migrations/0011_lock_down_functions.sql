-- Trigger functions are never meant to be called over the API. Pin the search path of the helper.
revoke all on function audit_view_insert() from public, anon, authenticated;
revoke all on function sync_doctor_info() from public, anon, authenticated;
revoke all on function sync_closure_info() from public, anon, authenticated;
alter function contains_patient_info(text) set search_path = public;
