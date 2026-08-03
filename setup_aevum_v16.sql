-- ============================================
-- Aevum Memory v1.6 · 情感权重 + 承诺区
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================

-- 1) 记忆表新增情感权重（0-10，召回打分用）
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS emotion_weight integer DEFAULT 5;

-- 2) 承诺区：雪对默许下的、需要固定可见的承诺
CREATE TABLE IF NOT EXISTS public.aevum_promises (
  id bigserial PRIMARY KEY,
  content text NOT NULL,
  source text DEFAULT 'manual',
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  archived boolean DEFAULT false
);
ALTER TABLE public.aevum_promises ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_promises_all ON public.aevum_promises;
CREATE POLICY aevum_promises_all ON public.aevum_promises FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT ALL ON public.aevum_promises TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_promises_id_seq TO anon, authenticated;
