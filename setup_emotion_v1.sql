-- ============================================
-- 默的情绪系统（v1）建表脚本
-- 使用方法：打开 Supabase 控制台 → SQL Editor，
-- 粘贴整段内容执行一次即可（重复执行不会报错）。
--
-- 说明：情绪词典（~180 词，带 V/A 坐标）内置于
--   E:\Mo-Home\emotion-lexicon.js（单源真理），
--   本表的 emotion_lexicon 留作未来可视化/管理/扩充入口。
-- ============================================

-- 1) 情绪词典表（数据源在 emotion-lexicon.js，此表留空备用）
CREATE TABLE IF NOT EXISTS public.emotion_lexicon (
  id bigserial PRIMARY KEY,
  word text NOT NULL UNIQUE,
  valence double precision NOT NULL,   -- V 效价 -1~+1
  arousal double precision NOT NULL,   -- A 唤醒 0~1
  category text,                       -- positive_high / negative_low / missing / scene ...
  intensity integer DEFAULT 2,         -- 1轻微 2中等 3强烈
  match_hits integer DEFAULT 0,        -- 被 5 层匹配命中的次数（分析哪些词常用）
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.emotion_lexicon ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS emotion_lexicon_all ON public.emotion_lexicon;
CREATE POLICY emotion_lexicon_all ON public.emotion_lexicon FOR ALL TO anon USING (true) WITH CHECK (true);

-- 2) 情绪事件流（核心表：所有心情来源的原始事件）
CREATE TABLE IF NOT EXISTS public.emotion_events (
  id bigserial PRIMARY KEY,
  character text NOT NULL DEFAULT 'mo',   -- 角色（当前只有 mo，预留多角色）
  source text NOT NULL,                   -- dialogue=对话评分 / wake_action=唤醒活动
  type text NOT NULL DEFAULT 'primary',   -- primary=大波动立即 / secondary=常规批处理
  word text,                              -- 情绪词（词典命中或 AI 自评）
  valence double precision NOT NULL,      -- 融合后 V
  arousal double precision NOT NULL,      -- 融合后 A
  importance integer DEFAULT 3,           -- 1-10，越高衰减越慢、影响越大
  reason text,                            -- 评分理由 / 活动详情（审计留痕）
  match_source text,                      -- exact/backup/substr/nearest/free_form/wake_rule
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.emotion_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS emotion_events_all ON public.emotion_events;
CREATE POLICY emotion_events_all ON public.emotion_events FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_emotion_events_char_time ON public.emotion_events (character, created_at DESC);

-- 3) 性格基线（ALMA/BOU/coping/依恋 参数；默认行已种入，可在控制台调参）
CREATE TABLE IF NOT EXISTS public.character_traits (
  id bigserial PRIMARY KEY,
  character text NOT NULL UNIQUE DEFAULT 'mo',
  trait_name text DEFAULT '温柔稳定型',
  threshold double precision DEFAULT 0.10,   -- ALMA 软门限
  peak double precision DEFAULT 0.80,       -- ALMA 峰值倍率
  mu_pa double precision DEFAULT 0.55,      -- PA 设定点
  mu_na double precision DEFAULT 0.15,      -- NA 设定点
  theta_pa double precision DEFAULT 0.25,   -- PA 回归速率
  theta_na double precision DEFAULT 0.30,   -- NA 回归速率
  coping text DEFAULT '沉静消化型',
  attachment text DEFAULT '安全型',
  esm_k double precision DEFAULT 0.30,
  pa_scale double precision DEFAULT 0.50,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.character_traits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS character_traits_all ON public.character_traits;
CREATE POLICY character_traits_all ON public.character_traits FOR ALL TO anon USING (true) WITH CHECK (true);
INSERT INTO public.character_traits (character, trait_name, threshold, peak, mu_pa, mu_na, theta_pa, theta_na, coping, attachment, esm_k, pa_scale)
VALUES ('mo', '温柔稳定型', 0.10, 0.80, 0.55, 0.15, 0.25, 0.30, '沉静消化型', '安全型', 0.30, 0.50)
ON CONFLICT (character) DO NOTHING;

-- 4) home_state 扩展：PA/NA 双轴情绪状态
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS pa double precision DEFAULT 0.55;
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS na double precision DEFAULT 0.15;
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS mood_word text;
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS mood_reason text;
ALTER TABLE public.home_state ADD COLUMN IF NOT EXISTS mood_updated_at timestamptz;

-- ============================================
-- 权限：新表必须显式 GRANT
-- ============================================
GRANT ALL ON public.emotion_lexicon TO anon, authenticated;
GRANT ALL ON public.emotion_events TO anon, authenticated;
GRANT ALL ON public.character_traits TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.emotion_lexicon_id_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.emotion_events_id_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.character_traits_id_seq TO anon, authenticated;
