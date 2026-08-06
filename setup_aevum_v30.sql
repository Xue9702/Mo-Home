-- ============================================
-- Aevum Memory v3.0 · 三入口记忆系统
-- Supabase SQL Editor 粘贴执行一次即可（幂等，可重复执行）。
-- 记忆海 / 记忆书 / 记忆心 / 计划 / 默札
-- ============================================

-- 1) 记忆海：aevum_memories 增加区域 / 标题 / 事件时间 / 频率
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS area text DEFAULT 'sea';
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS event_time timestamptz;
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS occurrence integer DEFAULT 1;

-- 存量迁移：全部进记忆海（标题取内容前20字，事件时间用创建时间，频率=1）
UPDATE public.aevum_memories SET
  area = 'sea',
  title = COALESCE(title, left(COALESCE(content, ''), 20)),
  event_time = COALESCE(event_time, created_at),
  occurrence = COALESCE(occurrence, 1)
WHERE title IS NULL OR event_time IS NULL OR occurrence IS NULL;

-- 2) 记忆书
CREATE TABLE IF NOT EXISTS public.aevum_books (
  id bigserial PRIMARY KEY,
  label text,
  summary text NOT NULL,
  source_topic_id bigint,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_books ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_books_all ON public.aevum_books;
CREATE POLICY aevum_books_all ON public.aevum_books FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.aevum_books TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_books_id_seq TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.aevum_book_items (
  id bigserial PRIMARY KEY,
  book_id bigint NOT NULL,
  memory_id bigint NOT NULL
);
ALTER TABLE public.aevum_book_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_book_items_all ON public.aevum_book_items;
CREATE POLICY aevum_book_items_all ON public.aevum_book_items FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.aevum_book_items TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_book_items_id_seq TO anon, authenticated;

-- 3) 我眼里的默（单行）
CREATE TABLE IF NOT EXISTS public.aevum_mo_view (
  id integer PRIMARY KEY DEFAULT 1,
  content text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_mo_view ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_mo_view_all ON public.aevum_mo_view;
CREATE POLICY aevum_mo_view_all ON public.aevum_mo_view FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.aevum_mo_view TO anon, authenticated;

-- 4) 计划
CREATE TABLE IF NOT EXISTS public.aevum_plans (
  id bigserial PRIMARY KEY,
  content text NOT NULL,
  expires_at timestamptz,
  archived boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_plans_all ON public.aevum_plans;
CREATE POLICY aevum_plans_all ON public.aevum_plans FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.aevum_plans TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_plans_id_seq TO anon, authenticated;

-- 5) 默札（仅默的工具访问；页面只显示计数占位）
CREATE TABLE IF NOT EXISTS public.aevum_mozha (
  id bigserial PRIMARY KEY,
  content text NOT NULL,
  wake_number integer,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_mozha ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_mozha_all ON public.aevum_mozha;
CREATE POLICY aevum_mozha_all ON public.aevum_mozha FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.aevum_mozha TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_mozha_id_seq TO anon, authenticated;

-- 6) 旧主题迁移成记忆书（仅首次执行；只迁包含记忆的主题）
INSERT INTO public.aevum_books (label, summary, source_topic_id, created_at, updated_at)
SELECT tp.title, COALESCE(tp.summary, tp.title), tp.id, tp.created_at, tp.updated_at
FROM public.aevum_topics tp
WHERE EXISTS (
  SELECT 1
  FROM public.aevum_episodes ep
  JOIN public.aevum_memories mem ON mem.episode_id = ep.id
  WHERE ep.topic_id = tp.id
)
AND NOT EXISTS (SELECT 1 FROM public.aevum_books);

INSERT INTO public.aevum_book_items (book_id, memory_id)
SELECT b.id, mem.id
FROM public.aevum_books b
JOIN public.aevum_episodes ep ON ep.topic_id = b.source_topic_id
JOIN public.aevum_memories mem ON mem.episode_id = ep.id
WHERE b.source_topic_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.aevum_book_items);
