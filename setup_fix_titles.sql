-- ============================================
-- 修复空标题：提取时 AI 常给空字符串，且 v30 迁移只补 NULL 不补 ''
-- 把空标题统一补为内容前 20 字（幂等，可重复执行）
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行
-- ============================================

UPDATE public.aevum_memories
SET title = left(regexp_replace(COALESCE(content, ''), '\s+', ' ', 'g'), 20)
WHERE title IS NULL OR btrim(title) = '';

-- 查看还剩多少空标题（应为 0）
-- SELECT count(*) FROM public.aevum_memories WHERE title IS NULL OR btrim(title) = '';
