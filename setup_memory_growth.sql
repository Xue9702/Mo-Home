-- Aevum 记忆生长（v1）：三级阈值候选表 / 记忆书版本历史 / 记忆关系边
-- 在 Supabase SQL Editor 里执行一次即可（幂等，可重复执行）

-- 记忆书关联候选：提取时新单元与某本书摘要相似度 ≥0.70 写入，待用户确认
CREATE TABLE IF NOT EXISTS aevum_book_candidates (
  id bigserial PRIMARY KEY,
  book_id bigint NOT NULL REFERENCES aevum_books(id) ON DELETE CASCADE,
  memory_id bigint NOT NULL REFERENCES aevum_memories(id) ON DELETE CASCADE,
  similarity double precision NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 记忆书版本历史：被替代的旧 summary 存档（保留演化过程）
CREATE TABLE IF NOT EXISTS aevum_book_versions (
  id bigserial PRIMARY KEY,
  book_id bigint NOT NULL REFERENCES aevum_books(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  summary text NOT NULL,
  source_unit_ids jsonb,
  relation_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 记忆间关系边：temporal_next / contradicts / supports
CREATE TABLE IF NOT EXISTS aevum_memory_links (
  id bigserial PRIMARY KEY,
  from_id bigint NOT NULL REFERENCES aevum_memories(id) ON DELETE CASCADE,
  to_id bigint NOT NULL REFERENCES aevum_memories(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_book_candidates_book ON aevum_book_candidates(book_id, status);
CREATE INDEX IF NOT EXISTS idx_book_versions_book ON aevum_book_versions(book_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_from ON aevum_memory_links(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON aevum_memory_links(to_id);

GRANT ALL ON public.aevum_book_candidates TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_book_candidates_id_seq TO anon, authenticated;
GRANT ALL ON public.aevum_book_versions TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_book_versions_id_seq TO anon, authenticated;
GRANT ALL ON public.aevum_memory_links TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.aevum_memory_links_id_seq TO anon, authenticated;
