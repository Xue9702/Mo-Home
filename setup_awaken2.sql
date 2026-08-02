-- ============================================
-- 互动唤醒菜单（第二期）数据库扩展
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================

-- home_state 扩展：好感值、虚拟雪的活动状态、默的睡眠留言
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS affection integer DEFAULT 0;
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS virtual_activity text;
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS sleep_note text;

-- 彩蛋图鉴（解锁过的收藏）
CREATE TABLE IF NOT EXISTS public.mo_collection (
  id bigserial PRIMARY KEY,
  item_key text NOT NULL UNIQUE,
  unlocked_at timestamptz DEFAULT now()
);
ALTER TABLE public.mo_collection ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mo_collection_all ON public.mo_collection;
CREATE POLICY mo_collection_all ON public.mo_collection FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT ALL ON public.mo_collection TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.mo_collection_id_seq TO anon, authenticated;
