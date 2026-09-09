-- ============================================
-- 模型配置表：前端设置页可切换对话/后台任务模型
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行（幂等）
-- 用途：V4.1 等新模型发布时，雪在设置页直接输入模型名即可切换，
--       不用等 Xylos 改代码。main_model=对话思考；task_model=记忆/书/情绪等后台
-- ============================================

CREATE TABLE IF NOT EXISTS public.model_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.model_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_config_all ON public.model_config;
CREATE POLICY model_config_all ON public.model_config FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.model_config TO anon, authenticated;

-- 默认值（deepseek-v4-flash 现状；V4.1 发布后改这里或直接在设置页改）
INSERT INTO public.model_config (key, value, updated_at)
VALUES
  ('main_model', 'deepseek-v4-flash', now()),
  ('task_model', 'deepseek-v4-flash', now())
ON CONFLICT (key) DO NOTHING;
