-- ============================================
-- Aevum Memory v1.5 · 六层级内容分析
-- Supabase SQL Editor 粘贴执行一次即可。
-- 新增 layer_content jsonb：存放 AI 评定的六个层级内容
-- （event/fact/meaning/relationship/personality/self_candidate），
-- 只存有内容的层级；content 始终等于当前生效层级的文本。
-- ============================================
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS layer_content jsonb;
