-- 自己採点ツールのテーブル。設計の根拠は decisions/013-自己採点ツールの設計.md
--
-- **正解は保持しない。**受験者が選んだ選択肢の分布だけを集計する。
-- 設問文も選択肢の文言も保存しない(著作権に触れないための設計)。
--
-- **D1無料枠(1日 書込10万行・読取500万行)で捌くための構造**:
--  - 投稿は1件=1行。解答は "31424..." の文字列にまとめる(問ごとに行を作らない)
--  - 集計は saiten_tally の**1行**にJSONで持つ。問ごとに集計行を持つと
--    1投稿あたり50行の書込になり、1万投稿で50万行=無料枠の5倍になる
--  - 100件ごとに差分だけ集計し、楽観ロックで1行を更新する

-- 投稿(真の記録。集計が壊れてもここから再計算できる)
CREATE TABLE IF NOT EXISTS saiten_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 試験の識別子。資格slug + 実施回。例: 'takken-2026'
  exam_key      TEXT    NOT NULL,
  -- 'general'(一般受験者・50問) / 'exempt'(登録講習修了者・問1〜45)
  answer_set    TEXT    NOT NULL,
  -- 解答を並べた文字列。1文字=1問。'1'〜'4'、未回答は '0'。
  -- 一般は50文字、登録講習修了者は45文字。
  answers       TEXT    NOT NULL,
  -- 未回答を除いた回答数。入力完了率の観測に使う
  answered      INTEGER NOT NULL,
  ip_hash       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_saiten_sub_exam ON saiten_submissions (exam_key, id);
-- 同一IPからの連投検出用(B-008 の投稿汚染対策と同じ考え方)
CREATE INDEX IF NOT EXISTS idx_saiten_sub_ip ON saiten_submissions (exam_key, ip_hash, created_at);

-- 集計(試験ごとに1行だけ)
CREATE TABLE IF NOT EXISTS saiten_tally (
  exam_key      TEXT    PRIMARY KEY,
  -- {"1":[a,b,c,d],"2":[...],...} 問番号 -> 選択肢1〜4の件数。
  -- 問1〜45は一般・登録講習修了者の両方が寄与する(同じ問題のため)。
  -- 問46〜50は一般受験者のみ。
  counts_json   TEXT    NOT NULL DEFAULT '{}',
  -- 集計に反映済みの saiten_submissions.id の上限。楽観ロックの比較キーを兼ねる
  upto_id       INTEGER NOT NULL DEFAULT 0,
  -- 集計に含まれた投稿数(母数の表示に使う)
  submissions   INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 宅建 令和8年度(2026/10/18)の行を先に作っておく。
-- 試験当日に行が無いことで初回リクエストが失敗する事故を防ぐ。
INSERT INTO saiten_tally (exam_key, counts_json, upto_id, submissions)
VALUES ('takken-2026', '{}', 0, 0)
ON CONFLICT DO NOTHING;
