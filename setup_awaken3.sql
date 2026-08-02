-- ============================================
-- 唤醒体验总结 字段扩展
-- Supabase SQL Editor 粘贴执行一次即可。
-- ============================================
ALTER TABLE public.mo_actions ADD COLUMN IF NOT EXISTS summary text;
