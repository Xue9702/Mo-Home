-- ============================================
-- 账本 v2：类别列 + 月预算表
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行（幂等）
-- ============================================

-- 账本加类别列（支出 13 类；收入统一"画稿"）
ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS category text;

-- 月预算（单行月）
CREATE TABLE IF NOT EXISTS public.ledger_budget (
  id bigserial PRIMARY KEY,
  budget_month text NOT NULL UNIQUE,   -- 如 2026-08
  expense_budget numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.ledger_budget ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_budget_all ON public.ledger_budget;
CREATE POLICY ledger_budget_all ON public.ledger_budget FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.ledger_budget TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.ledger_budget_id_seq TO anon, authenticated;
