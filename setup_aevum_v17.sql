-- ============================================
-- Aevum Memory v1.7 · 主题层 + 用户画像
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================

-- 1) 主题表：记忆地图（事件 → 主题）
CREATE TABLE IF NOT EXISTS public.aevum_topics (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  summary text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_topics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_topics_all ON public.aevum_topics;
CREATE POLICY aevum_topics_all ON public.aevum_topics FOR ALL TO anon USING (true) WITH CHECK (true);

-- 2) 事件块挂到主题
ALTER TABLE public.aevum_episodes ADD COLUMN IF NOT EXISTS topic_id bigint;

-- 3) 用户画像（单行，id=1）
CREATE TABLE IF NOT EXISTS public.aevum_profiles (
  id integer PRIMARY KEY DEFAULT 1,
  content text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_profiles_all ON public.aevum_profiles;
CREATE POLICY aevum_profiles_all ON public.aevum_profiles FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT ALL ON public.aevum_topics TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_topics_id_seq TO anon, authenticated;
GRANT ALL ON public.aevum_profiles TO anon, authenticated;
