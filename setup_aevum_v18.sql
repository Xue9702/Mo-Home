-- ============================================
-- Aevum Memory v1.8 · 画像分维度
-- Supabase SQL Editor 粘贴执行一次即可。
-- 画像从单段文字改为按维度(jsonb)存储，便于 AI 按维度填入、手动编辑。
-- ============================================
ALTER TABLE public.aevum_profiles ADD COLUMN IF NOT EXISTS dimensions jsonb;
