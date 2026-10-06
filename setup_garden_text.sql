-- 后花园 / 小屋文案与配置（与 arousal_lexicon 同套路：DB 优先，本地 garden-text.json 兜底）
-- 不执行本 SQL 也不会报错：读取时自动回退到仓库里的 garden-text.json，只是无法在前端编辑保存。
--
-- 用途：文案归文案、逻辑归逻辑——改措辞、加作物、调价格都只改这份 JSON，不用动代码。
-- 前端编辑页保存时，整份 JSON 覆盖写入 data 字段。

CREATE TABLE IF NOT EXISTS garden_text (
  id integer PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 首次导入可把 garden-text.json 的内容塞进去（用前端编辑页保存一次也行）：
-- INSERT INTO garden_text (id, data) VALUES (1, '{}'::jsonb)
--   ON CONFLICT (id) DO NOTHING;
