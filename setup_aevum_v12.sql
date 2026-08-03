-- ============================================
-- Aevum Memory v1.2 · 语义事件块（Semantic Episode）
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================
CREATE TABLE IF NOT EXISTS public.aevum_episodes (
  id bigserial PRIMARY KEY,
  topic text,
  intention text,
  emotional_context text,
  participants text[] DEFAULT '{雪,默}',
  status text NOT NULL DEFAULT 'open',
  started_at timestamptz DEFAULT now(),
  last_activity_at timestamptz DEFAULT now(),
  message_count integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.aevum_episodes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aevum_episodes_all ON public.aevum_episodes;
CREATE POLICY aevum_episodes_all ON public.aevum_episodes FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE public.aevum_raw ADD COLUMN IF NOT EXISTS episode_id bigint;

GRANT ALL ON public.aevum_episodes TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_episodes_id_seq TO anon, authenticated;
