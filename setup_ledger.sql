-- ============================================
-- 账本 + 日历日程标签 建表脚本
-- 使用方法：Supabase 控制台 → SQL Editor，粘贴执行一次。
-- ============================================

-- 1) 账本（收支记录）
CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id bigserial PRIMARY KEY,
  entry_date date NOT NULL,
  type text NOT NULL DEFAULT 'expense' CHECK (type IN ('income', 'expense')),
  amount numeric(12, 2) NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_all ON public.ledger_entries;
CREATE POLICY ledger_all ON public.ledger_entries FOR ALL TO anon USING (true) WITH CHECK (true);

-- 2) 日历日程标签（每天一句备注，可折叠展开）
CREATE TABLE IF NOT EXISTS public.day_tags (
  id bigserial PRIMARY KEY,
  tag_date date NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.day_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS day_tags_all ON public.day_tags;
CREATE POLICY day_tags_all ON public.day_tags FOR ALL TO anon USING (true) WITH CHECK (true);

-- 新表必须显式授权给 anon/authenticated，否则读写会 500
GRANT ALL ON public.ledger_entries TO anon, authenticated;
GRANT ALL ON public.day_tags TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.ledger_entries_id_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.day_tags_id_seq TO anon, authenticated;
