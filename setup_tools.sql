-- Mönix · MCP 工具开关表（v1）
-- 在 Supabase SQL Editor 里执行一次即可（幂等，可重复执行）

CREATE TABLE IF NOT EXISTS tool_switches (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.tool_switches TO anon, authenticated;

-- 默认全开（没配置的按开启处理，可留空；这里显式插入一份方便改）
INSERT INTO tool_switches (id, enabled) VALUES
  ('web_search', true),
  ('web_read', true),
  ('post_moment', true),
  ('toy_control', true),
  ('stardew_state', true),
  ('stardew_action', true),
  ('stardew_flow', true),
  ('mozha_write', true),
  ('mozha_read', true),
  ('set_reminder', true),
  ('todo_add', true),
  ('todo_done', true)
ON CONFLICT (id) DO NOTHING;
