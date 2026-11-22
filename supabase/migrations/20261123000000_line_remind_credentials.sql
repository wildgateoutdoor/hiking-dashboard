-- LINE 金鑰也可以存在 line_remind_config（Supabase Secrets 無法設定時用）；有值時優先於 Edge Function secrets
-- 這兩張表只有 Edge Function（service role）讀寫：RLS 開啟且沒有 policy，並收回 anon／authenticated 權限
alter table public.line_remind_config add column if not exists line_token text, add column if not exists line_secret text;
revoke all on public.line_remind_config from anon, authenticated;
revoke all on public.line_targets from anon, authenticated;
