-- ============================================
-- Aevum Memory v1.3 · 召回混合打分
-- Supabase SQL Editor 粘贴执行一次即可。
-- 新增只返回 (id, similarity) 的召回函数，供后端混合打分
-- （0.7 × 相似度 + 0.3 × 重要度/10）；不修改原 match_aevum_memories。
-- ============================================
CREATE OR REPLACE FUNCTION public.match_aevum_memories_scored(query_embedding vector(1024), match_count integer)
RETURNS TABLE (id bigint, similarity double precision)
LANGUAGE sql
STABLE
AS $$
  SELECT m.id, 1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.aevum_memories m
  WHERE m.status = 'active' AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_aevum_memories_scored(vector(1024), integer) TO anon, authenticated;
