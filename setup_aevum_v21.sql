-- ============================================
-- Aevum Memory v2.1 · 多维归属 + 主题聚类升级
-- Supabase SQL Editor 粘贴执行一次即可（幂等，可重复执行）。
-- 1) aevum_memories 新增 layers 列：一条记忆可同时属于多个层级维度
--    （例如"买了司沃康玩具并和默一起调试"既是事件也涉及关系）
-- 2) 幂等补齐 type 约束里的 user_tendency（若还没跑 v19，跑这个就够了）
-- ============================================
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS layers text[] DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.aevum_memories'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%user_tendency%'
  ) THEN
    ALTER TABLE public.aevum_memories DROP CONSTRAINT IF EXISTS aevum_memories_type_check;
    ALTER TABLE public.aevum_memories ADD CONSTRAINT aevum_memories_type_check
      CHECK (type IN ('event','fact','meaning','relationship','user_tendency','personality','self_candidate','self_model'));
  END IF;
END $$;
