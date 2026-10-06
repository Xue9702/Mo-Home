-- 后花园状态（与 arousal_state 同套路：单行 jsonb，整体读写）
-- 不执行本 SQL 也不会让现有功能出错：读取失败时用内存默认状态（花园不可用，其余照常）。
--
-- 状态结构见 garden-core.js 的 newState()：
--   { schema, coins, day(上次结算的自然日), plots[4], bag{}, fridge{}, chickens[], orders[], todayFlags{} }

CREATE TABLE IF NOT EXISTS garden_state (
  id integer PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 首次可留空；服务端读到空会自己初始化一份默认状态并写回。
