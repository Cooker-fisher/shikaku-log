-- ---------------------------------------------------------------------------
-- 0010: 勉強中の人が書き込み、返信で議論できるようにする
--
-- なぜ必要か:
--   これまでの投稿は「合格報告」しか受け付けていなかった。
--   しかし「危険物乙4 勉強時間」を検索するのは**受験前の人**であり、合格者ではない。
--   入口(検索)と出口(投稿フォーム)で対象者が一致しておらず、
--   PVをいくら積んでも投稿の分母が増えない構造だった(ADR-016)。
--
-- なぜ返信を持つか:
--   オーナーの指示「人が集まって議論できるようにしろ」。
--   5ch の資格板(乙4は part113 まで続いている)が示すとおり、
--   この領域には持続的な需要がある。
--
-- なぜ reports テーブルを再利用するか:
--   審査経路(status)・レート制限(ip_hash)・削除導線を1本に保つため。
--   別テーブルにすると、モデレーションの穴が2つになる。
-- ---------------------------------------------------------------------------

-- 投稿の種類。既存行は全て合格報告なので 'stats' で埋める。
--   stats  : 合格報告(数値中心。従来のもの)
--   thread : 勉強中の人の書き込み(自由文。議論の起点)
--   reply  : thread への返信
ALTER TABLE reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'stats'
  CHECK (kind IN ('stats', 'thread', 'reply'));

-- 返信元。thread と stats では NULL。
-- ON DELETE は張らない(D1の外部キーは既定で無効。親を消すときはアプリ側で子も消す)
ALTER TABLE reports ADD COLUMN parent_id INTEGER REFERENCES reports (id);

-- 表示名。空なら「名無し」。アカウントは作らせない(掟: オーナー以外は登録できない)
ALTER TABLE reports ADD COLUMN handle TEXT;

-- 自動公開したものと、人が公開したものを区別する。
-- 事故が起きたときに「どちらの経路で出たか」を切り分けられないと、原因が特定できない。
ALTER TABLE reports ADD COLUMN published_by TEXT
  CHECK (published_by IS NULL OR published_by IN ('auto', 'manual'));

-- 資格ページ + 種類 + 公開状態で引くのが主クエリになる
CREATE INDEX IF NOT EXISTS ix_reports_entity_kind_status
  ON reports (entity_id, kind, status, created_at DESC);

-- 返信を親でまとめて引く
CREATE INDEX IF NOT EXISTS ix_reports_parent
  ON reports (parent_id, status, created_at);
