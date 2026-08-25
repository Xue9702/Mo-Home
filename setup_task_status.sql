-- Aevum 记忆任务状态（默方案）：承诺/约定/待办的完成状态与双向挂链
-- 在 Supabase SQL Editor 里执行一次即可（幂等，可重复执行）

ALTER TABLE aevum_memories ADD COLUMN IF NOT EXISTS task_status text;
ALTER TABLE aevum_memories ADD COLUMN IF NOT EXISTS done_at timestamptz;
ALTER TABLE aevum_memories ADD COLUMN IF NOT EXISTS fulfills bigint[] DEFAULT '{}';
ALTER TABLE aevum_memories ADD COLUMN IF NOT EXISTS fulfilled_by bigint[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_aevum_memories_task_status ON aevum_memories(task_status);
CREATE INDEX IF NOT EXISTS idx_aevum_memories_task_done ON aevum_memories(task_status, done_at);
