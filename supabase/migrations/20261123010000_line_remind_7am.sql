-- LINE 團務提醒改成每天 07:00（台灣時間）＝ 前一天 23:00 UTC
select cron.alter_job((select jobid from cron.job where jobname = 'line-remind-daily'), schedule := '0 23 * * *');
-- 行前手冊發放：出發前 7 天提醒
update public.settings
set data = (select jsonb_agg(case when e->>'name' = '行前手冊發放' then jsonb_set(e, '{daysBefore}', '[7]'::jsonb) else e end)
            from jsonb_array_elements(data) e)
where key = 'taskReminders';
