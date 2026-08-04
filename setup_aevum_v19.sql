-- ============================================
-- Aevum Memory v2.0 · 类型图重构
-- Supabase SQL Editor 粘贴执行一次即可。
-- type 新增 user_tendency（用户倾向）；
-- self_candidate 保留在约束里仅兼容存量行（应用层已不再使用）。
-- ============================================
ALTER TABLE public.aevum_memories DROP CONSTRAINT IF EXISTS aevum_memories_type_check;
ALTER TABLE public.aevum_memories ADD CONSTRAINT aevum_memories_type_check
  CHECK (type IN ('event','fact','meaning','relationship','user_tendency','personality','self_candidate','self_model'));
