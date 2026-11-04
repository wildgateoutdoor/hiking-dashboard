-- 景點照片（https 網址或網站內的圖片路徑），「我想探索看看」的景點卡片最上方顯示
alter table public.wish_mountains add column if not exists photo_url text;
