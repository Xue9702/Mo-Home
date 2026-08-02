-- ============================================
-- Aevum Memory v1.0 · Phase 1 建表脚本
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================
CREATE TABLE IF NOT EXISTS public.aevum_memories (
  id bigserial PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('event','fact','meaning','relationship','personality','self_candidate','self_model')),
  owner text NOT NULL DEFAULT 'USER' CHECK (owner IN ('USER','RELATIONSHIP','AGENT','SYSTEM')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('raw','extracted','candidate','verified','active','archived','outdated','conflicted')),
  confidence jsonb DEFAULT '{"evidence":0.5,"stability":0.5,"importance":0.5}',
  evidence jsonb DEFAULT '[]',
  tags text[] DEFAULT '{}',
  source text,
  source_message_id bigint,
  review_note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_all ON public.aevum_memories;
CREATE POLICY aevum_all ON public.aevum_memories FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT ALL ON public.aevum_memories TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_memories_id_seq TO anon, authenticated;
