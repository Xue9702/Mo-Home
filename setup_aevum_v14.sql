-- ============================================
-- Aevum Memory v1.4 · 新增 rejected（已拒绝）状态
-- Supabase SQL Editor 粘贴执行一次即可。
-- 让"拒绝"与"归档"成为真正不同的状态：
--   rejected = 这条记忆不要了（标记已拒绝）
--   archived = 先收起来（随时可恢复）
-- 两者都退出"记忆海"、不参与召回，均可通过"恢复"回到 active。
-- ============================================
ALTER TABLE public.aevum_memories DROP CONSTRAINT IF EXISTS aevum_memories_status_check;
ALTER TABLE public.aevum_memories ADD CONSTRAINT aevum_memories_status_check
  CHECK (status IN ('raw','extracted','candidate','verified','active','archived','outdated','conflicted','rejected'));
