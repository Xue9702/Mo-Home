-- ============================================
-- Aevum Memory · Phase 4 原文存档（Layer 0 Raw Conversation）
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================
CREATE TABLE IF NOT EXISTS public.aevum_raw (
  id bigserial PRIMARY KEY,
  source text NOT NULL DEFAULT 'chat',
  role text NOT NULL DEFAULT 'exchange',
  content text NOT NULL,
  tags text[] DEFAULT '{}',
  importance integer DEFAULT 5,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_raw ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_raw_all ON public.aevum_raw;
CREATE POLICY aevum_raw_all ON public.aevum_raw FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT ALL ON public.aevum_raw TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_raw_id_seq TO anon, authenticated;
