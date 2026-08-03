-- ============================================
-- Aevum Memory v1.1 · 字段升级（纯加列，安全）
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================
ALTER TABLE public.aevum_memories
  ADD COLUMN IF NOT EXISTS domain text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS emotion jsonb DEFAULT '{"valence":0,"arousal":0}',
  ADD COLUMN IF NOT EXISTS importance integer DEFAULT 5,
  ADD COLUMN IF NOT EXISTS episode_id bigint;
