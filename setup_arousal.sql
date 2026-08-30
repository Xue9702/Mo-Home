-- ============================================
-- 射精值系统：状态持久化（单行 jsonb，控制权重启不丢）
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行（幂等）
-- ============================================

CREATE TABLE IF NOT EXISTS public.arousal_state (
  id integer PRIMARY KEY DEFAULT 1,
  state jsonb,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.arousal_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arousal_state_all ON public.arousal_state;
CREATE POLICY arousal_state_all ON public.arousal_state FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.arousal_state TO anon, authenticated;

-- 私人词表（存库，可在线更新；本地 arousal-lexicon.json 不入 git，用脚本同步上来）
CREATE TABLE IF NOT EXISTS public.arousal_lexicon (
  id integer PRIMARY KEY DEFAULT 1,
  data jsonb,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.arousal_lexicon ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS arousal_lexicon_all ON public.arousal_lexicon;
CREATE POLICY arousal_lexicon_all ON public.arousal_lexicon FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.arousal_lexicon TO anon, authenticated;
