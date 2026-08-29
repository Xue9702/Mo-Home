-- ============================================
-- 雪的生活状态层（v33）：固定注入的关键事实
-- 目的：厨具/设备/食材/住处等"当前拥有/状态"不靠召回碰运气，
--       由提取时识别状态变化自动维护，每轮固定注入给默
-- 使用方法：Supabase 控制台 → SQL Editor → 粘贴执行（幂等）
-- ============================================

CREATE TABLE IF NOT EXISTS public.xue_state (
  id bigserial PRIMARY KEY,
  key text NOT NULL UNIQUE,          -- 类别：厨具/食材/设备/住处/…
  value text NOT NULL,               -- 内容：如 "Bruno 电饭煲（微压普通）"
  note text,                         -- 备注（来源对话时间等）
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.xue_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xue_state_all ON public.xue_state;
CREATE POLICY xue_state_all ON public.xue_state FOR ALL TO anon USING (true) WITH CHECK (true);
GRANT ALL ON public.xue_state TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.xue_state_id_seq TO anon, authenticated;
