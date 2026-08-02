-- ============================================
-- 默的自主唤醒（第一期）建表脚本
-- 使用方法：打开 Supabase 控制台 → SQL Editor，
-- 粘贴整段内容执行一次即可（重复执行不会报错）。
-- ============================================

-- 1) 行动日志（默每次唤醒做的事）
CREATE TABLE IF NOT EXISTS public.mo_actions (
  id bigserial PRIMARY KEY,
  wake_number integer NOT NULL DEFAULT 1,
  action_date date,
  energy_spent integer DEFAULT 0,
  note text,
  actions jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.mo_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY mo_actions_all ON public.mo_actions FOR ALL TO anon USING (true) WITH CHECK (true);

-- 2) 日记（author='xue' 是雪的日记，author='mo' 是默的日记）
CREATE TABLE IF NOT EXISTS public.diary_entries (
  id bigserial PRIMARY KEY,
  author text NOT NULL DEFAULT 'xue',
  content text NOT NULL,
  entry_date date,
  mo_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.diary_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY diary_all ON public.diary_entries FOR ALL TO anon USING (true) WITH CHECK (true);

-- 3) 小屋状态（心情等，单行 id=1）
CREATE TABLE IF NOT EXISTS public.home_state (
  id integer PRIMARY KEY,
  mo_mood integer DEFAULT 60,
  xue_mood integer DEFAULT 60,
  last_active_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.home_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY home_state_all ON public.home_state FOR ALL TO anon USING (true) WITH CHECK (true);
INSERT INTO public.home_state (id, mo_mood, xue_mood) VALUES (1, 60, 60) ON CONFLICT (id) DO NOTHING;

-- 4) 浏览器通知队列（默发消息/亲亲抱抱时推给你）
CREATE TABLE IF NOT EXISTS public.notifications (
  id bigserial PRIMARY KEY,
  title text,
  body text,
  source text,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_all ON public.notifications FOR ALL TO anon USING (true) WITH CHECK (true);
