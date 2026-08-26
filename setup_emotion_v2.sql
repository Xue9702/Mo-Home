-- ============================================
-- 默的情绪系统（v2）增量脚本：OCC 目标评价字段
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行（幂等）
-- ============================================

-- emotion_events 增加 OCC 目标评价列（教程 5.3，加性调节 max ±0.1）
ALTER TABLE public.emotion_events ADD COLUMN IF NOT EXISTS goal_relevance double precision;
ALTER TABLE public.emotion_events ADD COLUMN IF NOT EXISTS desirability double precision;

-- 说明：无需额外权限变更（沿用已有表权限）
