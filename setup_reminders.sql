-- Aevum 小屋 · 闹钟 + Web Push 订阅表（v1）
-- 在 Supabase SQL Editor 里执行一次即可（幂等，可重复执行）

-- 闹钟表
CREATE TABLE IF NOT EXISTS reminders (
  id bigserial PRIMARY KEY,
  content text NOT NULL,
  remind_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 浏览器推送订阅表
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id bigserial PRIMARY KEY,
  endpoint text UNIQUE NOT NULL,
  keys jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 通知表补一列：已通过 Web Push 推送过的通知，页面打开时不再重复弹
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS push_sent boolean NOT NULL DEFAULT false;

-- 给 anon/authenticated 角色授权（Supabase 新表默认不开放，必须手动 GRANT）
GRANT ALL ON public.reminders TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.reminders_id_seq TO anon, authenticated;
GRANT ALL ON public.push_subscriptions TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.push_subscriptions_id_seq TO anon, authenticated;
