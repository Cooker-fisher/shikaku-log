#!/usr/bin/env node
/**
 * 本番の実挙動を検査するスモークテスト。`npm run smoke` で実行する。
 *
 * **なぜ必要か**: `npm run qa` はビルド成果物(dist/)の中身しか見られない。
 * 「存在しないURLに何が返るか」「APIが本当に動くか」といった実行時の挙動は
 * 検査できない。実際に2026-07-25、公開直後に以下の重大な不具合が起きていた:
 *
 *   404ページが無かったため Cloudflare Pages が存在しないURL全てに
 *   index.html を **200** で返していた。Googleは無限に重複ページを
 *   インデックスし、ソフト404としてサイト全体の評価を落とす。
 *
 * ビルドは通り、QAも通り、全ページ200で「成功」に見えていた。
 * 本番を叩かないと分からない類の不具合を捕まえるのがこのスクリプトの役割。
 *
 * 使い方:
 *   npm run smoke                      本番(https://shikaku-log.com)を検査
 *   npm run smoke -- https://xxx       任意のURLを検査
 */

const BASE = (process.argv[2] ?? 'https://shikaku-log.com').replace(/\/$/, '');

const UA = 'Mozilla/5.0 (compatible; shikakulog-smoke/1.0)';
const results = [];

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  const mark = ok ? '[32mPASS[0m' : '[31mFAIL[0m';
  console.log(`  ${mark}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function fetchStatus(path, opts = {}) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      ...opts,
    });
    return { status: res.status, res };
  } catch (err) {
    return { status: 0, error: String(err) };
  }
}

/** 1. 主要ページが 200 を返すか */
async function checkPages() {
  const paths = [
    '/',
    '/about/',
    '/privacy/',
    '/contact/',
    '/shikaku/kikenbutsu-otsu4/',
    '/shikaku/boki-3kyu/',
    '/sitemap.xml',
    '/robots.txt',
  ];
  for (const p of paths) {
    const { status } = await fetchStatus(p);
    record(status === 200, `200を返す: ${p}`, `status=${status}`);
  }
}

/**
 * 2. 存在しないURLが 404 を返すか(最重要)
 * 200が返る状態はソフト404であり、SEOを根本から壊す。
 */
async function checkNotFound() {
  const paths = [
    '/this-page-does-not-exist',
    '/aaaa/bbbb',
    '/shikaku/no-such-qualification/',
    '/news-sitemap.xml',
  ];
  for (const p of paths) {
    const { status } = await fetchStatus(p);
    record(status === 404, `404を返す: ${p}`, `status=${status}`);
  }
}

/** 3. 統計値が静的HTMLに含まれるか(JS依存になっていないか) */
async function checkStaticContent() {
  const { res, status } = await fetchStatus('/shikaku/kikenbutsu-otsu4/');
  if (status !== 200 || !res) {
    record(false, '統計値が静的HTMLに存在する', `ページを取得できない status=${status}`);
    return;
  }
  const html = await res.text();
  const hasStats = html.includes('222,545') && html.includes('31.9');
  record(hasStats, '統計値が静的HTMLに存在する(JS非依存)');

  // 閾値は「ページの情報価値がJSに依存していないこと」の目安。
  // 学習ペースツールと投稿フォームと構造化データで6個前後になる。
  // 情報価値そのものは上の統計値チェックで担保しているため、ここは急増の検知が目的。
  const scriptCount = (html.match(/<script/g) ?? []).length;
  record(scriptCount <= 10, 'scriptタグが想定内', `${scriptCount}個`);

  record(html.includes('rel="canonical"'), 'canonicalがある');
}

/** 4. 投稿APIが応答するか(GETは405、不正なslugは404) */
async function checkApi() {
  const { status: getStatus } = await fetchStatus('/api/report');
  record(getStatus === 405, 'API: GETは405を返す', `status=${getStatus}`);

  const { status: badSlug } = await fetchStatus('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      entity_type: 'certification',
      entity_slug: 'no-such-entity',
      form_loaded_at: Date.now() - 9000,
      website: '',
      payload: { study_hours: 1, attempts: 1, passed_year: 2026 },
    }),
  });
  record(badSlug === 404, 'API: 存在しない資格は404', `status=${badSlug}`);
}

/**
 * 5. 自己採点API が本番で応答するか
 *
 * **10月まで放置しない。**このAPIが必要になるのは宅建試験当日(2026/10/18 15:00)の
 * 一度きりで、そこで動かなければ年に一度の機会をまるごと失う。
 * 何ヶ月も前から本番で叩いておき、当日に初めて動かす状況を作らない。
 */
async function checkSaitenApi() {
  const { status, res } = await fetchStatus('/api/saiten?exam=takken-2026');
  if (status !== 200 || !res) {
    record(false, '自己採点API: 集計を返す', `status=${status}`);
  } else {
    const body = await res.json().catch(() => null);
    record(body?.ok === true && typeof body.submissions === 'number', '自己採点API: 集計を返す');
    record(
      typeof body?.disclaimer === 'string' && body.disclaimer.includes('正解ではありません'),
      'API応答に「正解ではない」注記が入っている',
    );
  }

  const { status: notFound } = await fetchStatus('/api/saiten?exam=no-such-exam');
  record(notFound === 404, '自己採点API: 未登録の試験は404', `status=${notFound}`);

  // 試験終了時刻より前は受け付けない。当日に手でデプロイして開放する運用にしないための守り
  const { status: locked } = await fetchStatus('/api/saiten', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      exam: 'takken-2026',
      answer_set: 'general',
      answers: '1'.repeat(50),
      form_loaded_at: Date.now() - 60_000,
      website: '',
    }),
  });
  record(locked === 423, '自己採点API: 試験終了前の投稿は423で拒否', `status=${locked}`);
}

/** 6. Search Consoleの所有権確認ファイルが到達可能か */
async function checkVerification() {
  try {
    const res = await fetch(`${BASE}/google38dead6bcabaacdf.html`, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
    });
    const text = await res.text();
    record(
      res.status === 200 && text.includes('google-site-verification'),
      'Search Consoleの所有権確認ファイルが到達可能',
    );
  } catch (err) {
    record(false, 'Search Consoleの所有権確認ファイルが到達可能', String(err));
  }
}

async function main() {
  console.log(`\n  スモークテスト: ${BASE}\n  ${'-'.repeat(58)}`);
  await checkPages();
  await checkNotFound();
  await checkStaticContent();
  await checkApi();
  await checkSaitenApi();
  await checkVerification();

  const failed = results.filter((r) => !r.ok);
  console.log(`  ${'-'.repeat(58)}`);
  if (failed.length === 0) {
    console.log(`  [32m全 ${results.length} 項目が通過[0m\n`);
    process.exit(0);
  }
  console.log(`  [31m${failed.length} / ${results.length} 項目が失敗[0m\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`  スモークテストが異常終了: ${err?.stack ?? err}`);
  process.exit(1);
});
