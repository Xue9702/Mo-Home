-- Aevum 小屋 · 待办清单表（v1）
-- 在 Supabase SQL Editor 里执行一次即可（幂等，可重复执行）

CREATE TABLE IF NOT EXISTS todos (
  id bigserial PRIMARY KEY,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);

GRANT ALL ON public.todos TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.todos_id_seq TO anon, authenticated;
