-- ============================================
-- Aevum Memory · Phase 3 向量召回
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================

-- 1) 启用 pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) 给记忆表加 embedding 列（阿里百炼 text-embedding-v4，1024 维）
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- 3) 召回函数：按向量相似度返回活跃记忆
CREATE OR REPLACE FUNCTION public.match_aevum_memories(query_embedding vector(1024), match_count integer)
RETURNS SETOF public.aevum_memories
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.aevum_memories
  WHERE status = 'active' AND embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 4) 授权匿名角色调用
GRANT EXECUTE ON FUNCTION public.match_aevum_memories(vector(1024), integer) TO anon, authenticated;
