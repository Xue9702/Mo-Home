-- 花园两张表缺 anon 权限，导致默种的东西存不进去（雪 10/6 抓到"数据没保留"）
-- 在 Supabase → SQL Editor 里整段执行即可。
-- 症状：默种下去的东西下次唤醒就没了；服务器一重启/部署，花园整个清空。

GRANT SELECT, INSERT, UPDATE, DELETE ON public.garden_state TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.garden_text  TO anon, authenticated;

-- 如果这两张表还没建，先跑 setup_garden_state.sql / setup_garden_text.sql，再跑上面这两行。