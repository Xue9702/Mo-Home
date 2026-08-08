-- ============================================
-- Aevum Memory v3.1 · 证据轮次 + 完整原文召回
-- Supabase SQL Editor 粘贴执行一次即可（幂等）。
-- aevum_memories 新增 evidence_turns：AI 概括事件单元时使用的是对话的第几轮到第几轮
-- （1 起编号，例如 [5,7]），召回重要度>7 的单元时把这几轮完整原文一起注入。
-- ============================================
ALTER TABLE public.aevum_memories ADD COLUMN IF NOT EXISTS evidence_turns integer[] DEFAULT '{}';
