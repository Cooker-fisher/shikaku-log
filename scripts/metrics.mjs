#!/usr/bin/env node
/**
 * 週次スナップショットを `metrics/` に記録する。`npm run metrics` で実行する。
 *
 * **なぜ作ったか**: 計画では週次でKPIを記録することになっていたが、
 * 公開から2日で `metrics/` は**0件**だった。記録する気が無かったのではなく、
 * 「手で書く作業」だったので毎回後回しになった。
 * qa と smoke だけが守られていたのは、それが `npm run` の中にあって飛ばせないからである。
 * だから記録も同じ場所に置く。
 *
 * **ゼロもゼロとして書く。**空欄にしない。ゼロが並ぶこと自体がデータである。
 *
 * 使い方:
 *   npm run metrics            自動で取れる数字だけ記録(D1とSearch Consoleにも接続する)
 *   npm run metrics -- --local 外部に接続しない(オフライン時)
 *
 * Search Console は `scripts/gsc.mjs` が API から取る(認証情報が無ければ null のまま)。
 * 残る手入力は ASP の管理画面の数字だけで、これは `null` のまま残り、
 * `npm run qa` が「何週間 null のままか」を数えて警告する。
 * 埋め忘れが自動で表面化する形にしてある。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { fetchSearchConsole, toManualFields } from './gsc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT_DIR = join(REPO, 'metrics');
const OFFLINE = process.argv.includes('--local');

const today = new Date().toISOString().slice(0, 10);

/** data/entities から公開中の資格を読む */
function entities() {
  const dir = join(ROOT, 'data', 'entities');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^﻿/, '')))
    .filter((e) => !e.draft);
}

/**
 * 統計の系列を持ち方の違いを吸収して取り出す。実際に3通りある。
 *   official_stats / official_stats_unified / official_stats_cbt … 直下に series
 *   official_stats_blocks … [{ key, label, stats: { series } }] の入れ子(FP3級・2級)
 * 入れ子を読めていなかったせいで FP の受験者数が長らく0として合計されていた。
 */
function statSeries(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((b) => statSeries(b?.stats ?? b));
  return Array.isArray(node.series) && node.series.length ? [node.series] : [];
}

/**
 * 最新年度の受験者数。
 * 学科と実技、統一試験とCBTは同じ人が両方に出てくるので、足さずに最大値を取る。
 */
function latestExaminees(e) {
  let max = 0;
  for (const key of Object.keys(e)) {
    if (!key.startsWith('official_stats')) continue;
    for (const series of statSeries(e[key])) {
      const v = series[0]?.examinees;
      if (typeof v === 'number' && v > max) max = v;
    }
  }
  return max;
}

/** D1 を1回のクエリで叩く。失敗しても記録は続ける(数字が無いことを null で残す) */
function d1(sql) {
  if (OFFLINE) return null;
  try {
    // SQLに空白が入るので、シェルに渡す1本の文字列として組み立てる(引数配列だと分割される)
    const out = execSync(
      `npx wrangler d1 execute shikakulog --remote --json --command "${sql.replace(/"/g, '\\"')}"`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
    const start = out.indexOf('[');
    if (start < 0) return null;
    return JSON.parse(out.slice(start))[0]?.results ?? null;
  } catch (err) {
    console.error(`  ! D1に接続できなかった: ${String(err).slice(0, 120)}`);
    return null;
  }
}

const list = entities();
const dist = join(ROOT, 'dist');
const pageCount = existsSync(dist)
  ? countHtml(dist)
  : null;

function countHtml(dir) {
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countHtml(join(dir, ent.name));
    else if (ent.name.endsWith('.html')) n += 1;
  }
  return n;
}

const reportRows = d1(
  "SELECT status, COUNT(*) AS n FROM reports GROUP BY status",
);
const entityRows = d1('SELECT COUNT(*) AS n FROM entities');
const saitenRows = d1('SELECT exam_key, submissions FROM saiten_tally');

const byStatus = Object.fromEntries((reportRows ?? []).map((r) => [r.status, r.n]));

/*
 * Search Console。**記録の中に置く。**別コマンドにすると、急いでいるときに飛ばされる
 * (metrics/ が公開2日で0件だったのと同じ理由)。取れなくても記録は続ける。
 */
const gsc = OFFLINE ? null : await fetchSearchConsole();

const snapshot = {
  date: today,
  /** 機械で取れる数字。null は「取れなかった」であって「ゼロ」ではない */
  auto: {
    published_pages: pageCount,
    qualification_pages: list.length,
    /** 掲載資格の最新年度受験者数の合計。市場規模の代理指標 */
    covered_examinees: list.reduce((s, e) => s + latestExaminees(e), 0),
    /**
     * 受験者数を1件も拾えなかった資格。合計が黙って小さく出るのを防ぐための内訳。
     * 統計の持ち方を増やしたときにここへ出る(FPの入れ子を読み落としていた再発防止)。
     */
    examinees_unread: list.filter((e) => latestExaminees(e) === 0).map((e) => e.slug),
    entities_in_d1: entityRows?.[0]?.n ?? null,
    reports_total: reportRows ? Object.values(byStatus).reduce((a, b) => a + b, 0) : null,
    reports_published: reportRows ? (byStatus.published ?? 0) : null,
    reports_pending: reportRows ? (byStatus.pending ?? 0) : null,
    saiten_submissions: saitenRows ? saitenRows.reduce((s, r) => s + (r.submissions ?? 0), 0) : null,
  },
  /**
   * 機械で取れなかった数字。null のまま放置されると `npm run qa` が警告する。
   *
   * gsc_* はかつて手入力だった。「Search Console は機械から読めない」と書いていたが、
   * Search Analytics API があり誤りだった(掟の「無い」の断定と同じ失敗)。
   * いまは `scripts/gsc.mjs` が埋める。認証情報が無いときだけ null が残る。
   * **ASP の管理画面は本当に API が無い**ので、affiliate_* と revenue_yen は手入力。
   */
  manual: {
    gsc_indexed: null,
    gsc_impressions_7d: null,
    gsc_clicks_7d: null,
    gsc_avg_position: null,
    gsc_top_queries: null,
    ...(gsc ? toManualFields(gsc) : {}),
    affiliate_clicks: null,
    revenue_yen: null,
  },
  note: '',
};

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `${today}.json`);
writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

const a = snapshot.auto;
console.log('');
console.log(`  週次スナップショット: metrics/${today}.json`);
console.log('  ' + '-'.repeat(58));
console.log(`  公開ページ数          ${a.published_pages ?? '取得不可(先に npm run build)'}`);
console.log(`  資格ページ数          ${a.qualification_pages}`);
console.log(`  掲載資格の受験者合計  ${a.covered_examinees.toLocaleString('ja-JP')} 人`);
if (a.examinees_unread.length) {
  console.log(`  ⚠ 受験者数を拾えず   ${a.examinees_unread.join(', ')}`);
}
console.log(`  D1の資格件数          ${a.entities_in_d1 ?? '取得不可'}`);
console.log(`  合格報告(累計/公開)   ${a.reports_total ?? '—'} / ${a.reports_published ?? '—'}`);
console.log(`  自己採点の送信        ${a.saiten_submissions ?? '—'}`);
console.log('  ' + '-'.repeat(58));

const m = snapshot.manual;
if (gsc) {
  console.log(`  検索の表示回数(${gsc.period.startDate}〜${gsc.period.endDate})`);
  console.log(`    表示 ${m.gsc_impressions_7d} / クリック ${m.gsc_clicks_7d} / 平均 ${m.gsc_avg_position ?? '—'}位`);
  console.log(`    表示のあるページ ${gsc.pages_with_impressions} 件`);
  for (const q of (m.gsc_top_queries ?? []).slice(0, 5)) console.log(`    ${q}`);
  console.log('  ' + '-'.repeat(58));
} else if (!OFFLINE) {
  console.log('  🟡 Search Console から取れませんでした(認証情報を .env に置く: scripts/gsc.mjs 冒頭)');
}
console.log('  🔴 ASP の数字が未記入です。管理画面を開いて');
console.log(`     metrics/${today}.json の affiliate_clicks / revenue_yen を埋めてください。`);
console.log('     埋めないまま2週間経つと npm run qa が ERROR で止まります。');
console.log('');
