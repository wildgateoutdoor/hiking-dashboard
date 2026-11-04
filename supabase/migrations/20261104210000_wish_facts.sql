-- 景點小檔案（取自各景點的報名表單「行程介紹」）：{"difficulty":"★★★☆☆☆","altitude":"2,600 → 3,952m","distance":"21.8km","duration":"2天2夜"}
alter table public.wish_mountains add column if not exists facts jsonb;
