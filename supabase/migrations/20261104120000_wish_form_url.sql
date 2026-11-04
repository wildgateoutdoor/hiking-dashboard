-- 每座山一張 Google 報名表單（日期在表單內選），前台「前往報名」直接打開
alter table public.wish_mountains add column if not exists form_url text;
