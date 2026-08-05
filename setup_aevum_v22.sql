-- ============================================
-- Aevum Memory v2.2 · 主体收敛为 雪/默/其他
-- Supabase SQL Editor 粘贴执行一次即可（幂等）。
-- 1) owner 枚举新增 OTHER（其他：小屋/系统/开发进展等）
-- 2) 存量 RELATIONSHIP / SYSTEM 主体迁移为 OTHER
-- 3) 保留旧枚举值仅作兼容存量行（应用层不再使用）
-- ============================================
ALTER TABLE public.aevum_memories DROP CONSTRAINT IF EXISTS aevum_memories_owner_check;
ALTER TABLE public.aevum_memories ADD CONSTRAINT aevum_memories_owner_check
  CHECK (owner IN ('USER','AGENT','SYSTEM','RELATIONSHIP','OTHER'));

UPDATE public.aevum_memories SET owner = 'OTHER', updated_at = now()
  WHERE owner IN ('RELATIONSHIP','SYSTEM');
