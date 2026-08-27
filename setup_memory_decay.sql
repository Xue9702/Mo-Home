-- ============================================
-- 记忆衰减增强（D）：resolved 沉底字段
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行（幂等）
-- ============================================

-- resolved：这条记忆的"情绪/事件"是否已被后续了结（如吵完架又和好）
-- 了结后衰减因子 ×0.05，大幅沉底，不再总是被召回；但记忆本身永不物理删除
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS resolved boolean DEFAULT false;

-- 说明：decay_score 实时计算不落库；检索强化(activation_count)与永不遗忘白名单(pinned)本轮不做
