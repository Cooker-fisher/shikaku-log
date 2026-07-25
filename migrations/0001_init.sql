-- 0001_init.sql
--
-- 汎用「対象物 × ユーザー投稿 × 集計」スキーマ。
-- 1号店(資格ログDB)専用にせず、2号店(住まい・お金の実例DB)でそのまま使い回せる命名にしてある。
--   entities.type = 'certification' | 'property_type' | 'loan_type' | ...
-- 資格特有の項目は entities.attributes / reports.payload の JSON 側に逃がす。
--
-- 適用: npm run db:migrate:local  /  npm run db:migrate

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- entities : 対象物(資格・物件タイプ・制度 など)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT    NOT NULL,                       -- 対象物の種類
  slug           TEXT    NOT NULL,                       -- URL片(例: 'takken')
  name           TEXT    NOT NULL,                       -- 表示名(例: '宅地建物取引士')
  category       TEXT,                                   -- 分類(例: '不動産' / '国家資格')
  -- 型ごとの属性。資格なら受験料・受験資格・実施団体・公式URL など
  attributes     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  -- 公式統計。必ず一次ソースURLを同梱する(掟 3-1)
  -- 例: {"source_url":"https://...","fetched_at":"2026-07-01","series":[{"year":2025,"applicants":283856,"passers":40025,"pass_rate":0.141}]}
  official_stats TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(official_stats)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- (type, slug) は一意。型をまたげば同じ slug を使ってよい
CREATE UNIQUE INDEX IF NOT EXISTS ux_entities_type_slug ON entities (type, slug);
CREATE INDEX IF NOT EXISTS ix_entities_type_category   ON entities (type, category);

CREATE TRIGGER IF NOT EXISTS tr_entities_updated_at
AFTER UPDATE ON entities
FOR EACH ROW
BEGIN
  UPDATE entities
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = OLD.id;
END;

-- ---------------------------------------------------------------------------
-- reports : ユーザー投稿(合格報告 / 実例報告)
-- ---------------------------------------------------------------------------
-- payload の中身は entities.type ごとに report_schemas で定義する。
-- 資格の例: {"study_hours":420,"attempts":2,"passed_year":2025,"materials":["みんなが欲しかった"],"comment":"..."}
CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id       INTEGER NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  payload         TEXT    NOT NULL CHECK (json_valid(payload)),
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'published', 'rejected')),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  published_at    TEXT,
  -- 生IPは保存しない。ソルト付き SHA-256 の先頭のみ(掟: プライバシー)
  ip_hash         TEXT,
  user_agent_hash TEXT,
  -- 審査メモ(NGワード検知理由など)。個人情報は入れない
  review_note     TEXT
);

CREATE INDEX IF NOT EXISTS ix_reports_entity          ON reports (entity_id);
CREATE INDEX IF NOT EXISTS ix_reports_status          ON reports (status);
-- 集計クエリ(公開済みだけを entity 単位で引く)の主役
CREATE INDEX IF NOT EXISTS ix_reports_entity_status   ON reports (entity_id, status);
-- レートリミット用(同一IPハッシュの直近投稿を引く)
CREATE INDEX IF NOT EXISTS ix_reports_iphash_created  ON reports (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS ix_reports_status_created  ON reports (status, created_at);

-- ---------------------------------------------------------------------------
-- metrics_cache : 集計結果のキャッシュ
-- ---------------------------------------------------------------------------
-- ビルド時 / バッチで src/lib/metrics.ts の出力をそのまま入れる。
-- value には必ず sampleSize と status('collecting'|'ready') が含まれる。
CREATE TABLE IF NOT EXISTS metrics_cache (
  entity_id   INTEGER NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  metric_key  TEXT    NOT NULL,                          -- 例: 'study_hours' / 'materials'
  value       TEXT    NOT NULL CHECK (json_valid(value)),
  sample_size INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (entity_id, metric_key)
);

CREATE INDEX IF NOT EXISTS ix_metrics_cache_key ON metrics_cache (metric_key);

-- ---------------------------------------------------------------------------
-- report_schemas : 投稿フォームの定義(entities.type ごとに切り替える)
-- ---------------------------------------------------------------------------
-- schema は src/lib/validation.ts の FieldSpec 形式。フォーム生成とサーバ側検証の
-- 両方をこの1定義から駆動し、フロントとAPIで検証がズレないようにする。
CREATE TABLE IF NOT EXISTS report_schemas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT    NOT NULL,
  schema      TEXT    NOT NULL CHECK (json_valid(schema)),
  version     INTEGER NOT NULL DEFAULT 1,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_report_schemas_type_version
  ON report_schemas (entity_type, version);

-- 資格(1号店)の初期スキーマ。src/lib/validation.ts の CERTIFICATION_REPORT_SCHEMA と同じ内容。
INSERT OR IGNORE INTO report_schemas (entity_type, schema, version, is_active) VALUES (
  'certification',
  '{"fields":{'
  || '"study_hours":{"type":"int","minExclusive":0,"maxInclusive":10000,"required":true,"label":"総勉強時間"},'
  || '"attempts":{"type":"int","minInclusive":1,"maxInclusive":20,"required":true,"label":"受験回数"},'
  || '"passed_year":{"type":"int","minInclusive":2000,"maxInclusive":2100,"required":true,"label":"合格年"},'
  || '"study_months":{"type":"int","minInclusive":1,"maxInclusive":240,"required":false,"label":"学習期間(月)"},'
  || '"method":{"type":"enum","values":["independent","online","school","company"],"required":false,"label":"学習方法"},'
  || '"materials":{"type":"string[]","maxItems":5,"maxLength":60,"moderate":true,"required":false,"label":"使用教材"},'
  || '"comment":{"type":"string","maxLength":400,"moderate":true,"required":false,"label":"ひとこと"}'
  || '}}',
  1,
  1
);
