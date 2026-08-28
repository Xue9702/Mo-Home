-- ============================================
-- 记忆书更新次数（v32）：updated_count 列
-- 之前续写更新不写版本表，导致"更新次数"统计不到。
-- 改为 books 表自身计数（可靠），存量初始化：更新过至少 1 次的置 1。
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行（幂等）
-- ============================================

ALTER TABLE public.aevum_books ADD COLUMN IF NOT EXISTS updated_count integer DEFAULT 0;

-- 存量初始化 A：updated_at 明显晚于 created_at 的书视为至少更新过 1 次（无法追溯真实次数）
UPDATE public.aevum_books
SET updated_count = 1
WHERE updated_count = 0
  AND updated_at > created_at + interval '1 minute';

-- 存量初始化 B：有过 confirmed 候选历史（点过"生成故事"确认续写）的书也视为至少更新过 1 次
-- （早期续写可能成功追加了事件但未更新 summary/版本，这里一并标记）
UPDATE public.aevum_books
SET updated_count = GREATEST(updated_count, 1)
WHERE EXISTS (
  SELECT 1 FROM public.aevum_book_candidates c
  WHERE c.book_id = public.aevum_books.id AND c.status = 'confirmed'
);

-- 说明：今后每次续写成功 updated_count +1，版本表继续记录（供"故事变化"追溯）
