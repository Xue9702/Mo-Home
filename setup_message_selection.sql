-- 消息版本"选中"标记
-- 背景：刷新/编辑会产生同一 group_id 的多个版本（1/3、2/3、3/3）。
--       loadLatestHistory 原来永远取版本号最大的那条 → 雪选了 2/3 继续聊，
--       重开 App 后默读到的历史又变回 3/3（雪 2026/10/4 反馈）。
-- 本列记录"雪当前选中看的是哪一版"，历史注入优先用它。
--
-- 兼容性：不执行本 SQL 也不会报错——读取时会自动降级回"版本号最大"（与现在行为一致），
--         只是"选中的版本"不会被记住。
-- 历史数据无需回填：没有 true 标记时自动回退到版本号最大。

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_selected boolean NOT NULL DEFAULT false;

-- 按组查选中版本用
CREATE INDEX IF NOT EXISTS idx_messages_group_selected ON messages (group_id, is_selected);

-- 可选：查看当前各组的版本情况
-- SELECT group_id, role, version_number, is_selected, left(content, 40), created_at
--   FROM messages WHERE group_id IS NOT NULL
--   ORDER BY group_id, role, version_number;
