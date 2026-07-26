/**
 * data/entities/*.json から entities テーブルのシードSQLを生成する。
 *
 * **なぜ手書きしないか**: 2026-07-26、資格を2件追加したとき本番D1に直接INSERTし、
 * マイグレーションに書き忘れた。本番は正常に見えるので気づけず、DBを作り直した瞬間に
 * その資格の投稿だけが404になる状態だった。同じ教訓を前日に 0003 で書いた直後の再発である。
 * **手順書は守られない。**JSONを正とし、SQLは常にそこから生成する。
 *
 * 使い方:
 *   node scripts/gen-entity-seed.mjs <slug> [<slug> ...] > migrations/000N_seed_xxx.sql
 *   node scripts/gen-entity-seed.mjs --all   (draft を除く全件)
 *
 * 生成物は ON CONFLICT DO NOTHING なので、既に入っている行は変更しない。
 * **既存行の内容を更新したい場合はこのスクリプトでは足りない**(UPDATE を別途書くこと)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'entities');

/** SQLの文字列リテラルに埋める。シングルクォートは '' にエスケープする */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function load(file) {
  // JSONがBOM付きで保存されることがある
  return JSON.parse(readFileSync(join(DIR, file), 'utf8').replace(/^﻿/, ''));
}

function toSql(e) {
  // attributes = 表示に使う残り全部。official_stats* だけ別カラムに分ける。
  // このカラム分けは 0002 のシードに合わせている。
  const attributes = {};
  const stats = {};
  for (const [k, v] of Object.entries(e)) {
    if (['type', 'slug', 'name', 'category', 'draft', 'draft_reason'].includes(k)) continue;
    if (k.startsWith('official_stats')) stats[k] = v;
    else attributes[k] = v;
  }
  return (
    `INSERT INTO entities (type, slug, name, category, attributes, official_stats)\n` +
    `VALUES (${q(e.type)}, ${q(e.slug)}, ${q(e.name)}, ${q(e.category)}, ` +
    `${q(JSON.stringify(attributes))}, ${q(JSON.stringify(stats))})\n` +
    `ON CONFLICT DO NOTHING;`
  );
}

const args = process.argv.slice(2);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const wanted = args.includes('--all')
  ? files.filter((f) => !load(f).draft)
  : files.filter((f) => args.includes(load(f).slug));

if (wanted.length === 0) {
  console.error('該当する資格が無い。slug を確認すること。');
  process.exit(1);
}

const missing = args.filter((a) => a !== '--all' && !wanted.some((f) => load(f).slug === a));
if (missing.length) {
  console.error(`存在しない slug: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('-- data/entities/*.json から scripts/gen-entity-seed.mjs で生成。手で編集しない。');
console.log('-- 正は JSON 側。統計の表示はビルド時にJSONから埋め込むため、この行は投稿APIの照合用。');
console.log('');
for (const f of wanted) {
  const e = load(f);
  console.log(`-- ${e.name}`);
  console.log(toSql(e));
  console.log('');
}
