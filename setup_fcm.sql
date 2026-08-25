-- Mönix FCM 推送：APK 关闭也能收到默的唤醒/闹钟消息
-- 在 Supabase SQL Editor 里执行一次即可（幂等，可重复执行）

CREATE TABLE IF NOT EXISTS fcm_tokens (
  token text PRIMARY KEY,
  device text DEFAULT 'android',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.fcm_tokens TO anon, authenticated;
