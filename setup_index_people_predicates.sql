-- Aevum 记忆人物/谓词索引：除了名词标签外的两条精确检索路径
-- 在 Supabase SQL Editor 里执行一次即可（幂等，可重复执行）

-- 每条记忆的人物索引（除雪/默之外出现的人）与动作/心理谓词索引
ALTER TABLE aevum_memories ADD COLUMN IF NOT EXISTS people jsonb DEFAULT '[]';
ALTER TABLE aevum_memories ADD COLUMN IF NOT EXISTS predicates jsonb DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_aevum_memories_people ON aevum_memories USING GIN (people);
CREATE INDEX IF NOT EXISTS idx_aevum_memories_predicates ON aevum_memories USING GIN (predicates);

-- 索引开关配置：关掉的索引词不参与召回加分
CREATE TABLE IF NOT EXISTS aevum_index_config (
  kind text NOT NULL,
  value text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);

GRANT ALL ON public.aevum_index_config TO anon, authenticated;
