#!/usr/bin/env node
/**
 * Search Console の検索パフォーマンスを機械で取り、週次スナップショットに書き込む。
 *
 * **なぜ作ったか**: `scripts/metrics.mjs` は
 * 「Search Console と ASP の管理画面は**機械から読めない**」と書いていた。
 * これは掟の禁じている「無い」の断定そのもので、実際には誤りだった。
 * Search Console には Search Analytics API と URL Inspection API があり、
 * 表示回数・クリック数・平均掲載順位・クエリ・インデックス状況はすべて機械で取れる。
 * (ASP の管理画面は本当に API が無いので、そちらは手入力のまま残す)
 *
 * 手で入れる欄にしてある限り埋め忘れる。P-004 では表示回数を測っていなかったため
 * 配信ゼロに2日間気づけなかった。**測り忘れを機械で潰すのがこのスクリプトである。**
 *
 * 使い方:
 *   npm run gsc                最新のスナップショットに直近7日の数字を書き込む
 *   npm run gsc -- --inspect   インデックス済みページ数も数える(sitemapの各URLを照会)
 *   npm run gsc -- --days 28   集計期間を変える(既定は7日)
 *   npm run gsc -- --end 2026-07-28  終端日を指定する(既定は「今日-3日」)
 *   npm run gsc -- --print     スナップショットに書かず表示だけする
 *
 * `npm run metrics` からも呼ばれる。認証情報が無ければ何もせず 0 で終わる
 * (記録そのものは止めない。数字は null のまま残り、qa が未記入として警告する)。
 *
 * 認証情報(いずれか。すべて .env / .dev.vars に置く。どちらも gitignore 済み):
 *
 *   A. サービスアカウント(推奨。期限切れが無い)
 *      GSC_SERVICE_ACCOUNT_FILE=/path/to/key.json
 *      または GSC_SERVICE_ACCOUNT_JSON={"client_email":...,"private_key":...}
 *      → Google Cloud でサービスアカウントを作り、鍵(JSON)を落とし、
 *        Search Console の「設定 > ユーザーと権限」でその client_email を
 *        **制限付き**ユーザーとして追加する。API の有効化は
 *        Google Cloud の「Google Search Console API」で行う。
 *
 *   B. OAuth のリフレッシュトークン
 *      GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN
 *
 *   任意: GSC_SITE_URL=https://shikaku-log.com/  (既定。ドメインプロパティなら
 *         sc-domain:shikaku-log.com を入れる。片方で権限エラーなら他方を自動で試す)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** metrics/ と retro/ は公開リポジトリの外(親ディレクトリ)に置いてある */
const METRICS_DIR = join(ROOT, '..', 'metrics');

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://searchconsole.googleapis.com';

/* ------------------------------------------------------------------ 引数 */

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const FLAGS = {
  inspect: process.argv.includes('--inspect'),
  print: process.argv.includes('--print'),
  days: Math.max(1, Number(argValue('days', '7')) || 7),
  end: argValue('end', null),
  inspectLimit: Math.max(1, Number(argValue('inspect-limit', '50')) || 50),
};

/* ------------------------------------------------------- 環境変数の読み込み */

/**
 * `.env` / `.dev.vars` を読む。既に process.env にある値は上書きしない。
 * 「export し忘れて動かない」で時間を落とすのを避けるためだけの処理で、
 * 依存を増やしてまで dotenv を入れる価値は無い。
 */
function loadEnvFiles() {
  for (const name of ['.env', '.dev.vars']) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

/* -------------------------------------------------------------- 認証 */

function serviceAccount() {
  const file = process.env.GSC_SERVICE_ACCOUNT_FILE;
  const inline = process.env.GSC_SERVICE_ACCOUNT_JSON;
  let text = null;
  if (file && existsSync(file)) text = readFileSync(file, 'utf8');
  else if (inline) {
    // 1行に押し込むために base64 で入れている場合も受ける
    text = inline.trim().startsWith('{')
      ? inline
      : Buffer.from(inline, 'base64').toString('utf8');
  }
  if (!text) return null;
  const key = JSON.parse(text);
  if (!key.client_email || !key.private_key) {
    throw new Error('サービスアカウント鍵に client_email / private_key が無い');
  }
  return key;
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/** サービスアカウント鍵で署名した JWT をアクセストークンに交換する */
async function tokenFromServiceAccount(key) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claim));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  const assertion = `${head}.${body}.${signer.sign(key.private_key.replace(/\\n/g, '\n'), 'base64url')}`;

  return postToken(claim.aud, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
}

async function tokenFromRefreshToken() {
  return postToken('https://oauth2.googleapis.com/token', {
    client_id: process.env.GSC_CLIENT_ID,
    client_secret: process.env.GSC_CLIENT_SECRET,
    refresh_token: process.env.GSC_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
}

async function postToken(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`トークン取得に失敗 (${res.status}): ${text.slice(0, 300)}`);
  const token = JSON.parse(text).access_token;
  if (!token) throw new Error(`access_token が返らなかった: ${text.slice(0, 200)}`);
  return token;
}

/** 認証情報が無ければ null。あれば access token を返す */
async function accessToken() {
  const key = serviceAccount();
  if (key) return { token: await tokenFromServiceAccount(key), how: `サービスアカウント (${key.client_email})` };
  if (process.env.GSC_CLIENT_ID && process.env.GSC_CLIENT_SECRET && process.env.GSC_REFRESH_TOKEN) {
    return { token: await tokenFromRefreshToken(), how: 'OAuth リフレッシュトークン' };
  }
  return null;
}

/* ---------------------------------------------------------- 期間の決め方 */

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Search Console のデータは2〜3日遅れて確定する。
 * 「今日まで」で取ると直近が必ず低く出て、増減の判断を誤る。
 * だから終端は既定で「今日-3日」に置き、期間はそこから遡る。
 */
function window() {
  const end = FLAGS.end ? new Date(`${FLAGS.end}T00:00:00Z`) : new Date(Date.now() - 3 * 86_400_000);
  const start = new Date(end.getTime() - (FLAGS.days - 1) * 86_400_000);
  return { startDate: iso(start), endDate: iso(end) };
}

/* -------------------------------------------------------------- API 呼び出し */

async function apiPost(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

const searchAnalytics = (site, token, body) =>
  apiPost(`/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, token, {
    type: 'web',
    dataState: 'final',
    ...body,
  });

/**
 * プロパティの形が2通りある(URLプレフィックス / ドメイン)。
 * 登録した形と違う方を叩くと 403 になり、原因が認証エラーに見えて紛らわしい。
 * 片方で権限エラーなら他方を試し、**どちらで通ったかを表示する**。
 */
async function resolveSite(token, period) {
  const configured = process.env.GSC_SITE_URL;
  const candidates = configured
    ? [configured]
    : ['https://shikaku-log.com/', 'sc-domain:shikaku-log.com'];
  let lastErr = null;
  for (const site of candidates) {
    try {
      const totals = await searchAnalytics(site, token, { ...period, dimensions: [] });
      return { site, totals };
    } catch (err) {
      lastErr = err;
      if (err.status !== 403 && err.status !== 404) throw err;
    }
  }
  throw new Error(
    `プロパティにアクセスできなかった (${candidates.join(' / ')}): ${lastErr?.message ?? '不明'}\n` +
      '  → Search Console の「設定 > ユーザーと権限」に認証情報のメールアドレスを追加したか確認する',
  );
}

/* -------------------------------------------------- インデックス済みページ数 */

/**
 * sitemap.xml の各URLを URL Inspection API に通し、インデックス済みの件数を数える。
 * カバレッジ全体の件数は API に無いので、**自分が出したいURLの中で何件入ったか**を数える。
 * こちらの方が「出したのに入っていない」を直接示すため、判断に使える。
 *
 * 1URLごとに1リクエスト(1日2000件まで)。既定は50件で打ち切り、打ち切ったことを表示する。
 */
async function indexedCount(site, token) {
  const res = await fetch('https://shikaku-log.com/sitemap.xml', {
    headers: { 'User-Agent': 'shikakulog-gsc/1.0' },
  });
  if (!res.ok) throw new Error(`sitemap.xml が取れなかった (${res.status})`);
  const urls = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const targets = urls.slice(0, FLAGS.inspectLimit);

  let indexed = 0;
  const notIndexed = [];
  for (const url of targets) {
    try {
      const out = await apiPost('/v1/urlInspection/index:inspect', token, {
        inspectionUrl: url,
        siteUrl: site,
        languageCode: 'ja',
      });
      const status = out.inspectionResult?.indexStatusResult ?? {};
      if (status.verdict === 'PASS') indexed += 1;
      else notIndexed.push(`${new URL(url).pathname} (${status.coverageState ?? status.verdict ?? '不明'})`);
    } catch (err) {
      notIndexed.push(`${new URL(url).pathname} (照会失敗: ${String(err.message).slice(0, 60)})`);
    }
  }
  return { indexed, checked: targets.length, total: urls.length, notIndexed };
}

/* ------------------------------------------------------------ 取得本体 */

/**
 * 直近の検索パフォーマンスを取る。認証情報が無ければ null を返す。
 * `metrics.mjs` からも呼ぶので、**例外を投げずに null を返す**ことを守る
 * (Search Console が取れないことで週次記録そのものが落ちてはならない)。
 */
export async function fetchSearchConsole({ quiet = false } = {}) {
  loadEnvFiles();

  let auth;
  try {
    auth = await accessToken();
  } catch (err) {
    if (!quiet) console.error(`  ! 認証に失敗した: ${err.message}`);
    return null;
  }
  if (!auth) {
    if (!quiet) {
      console.log('  - Search Console の認証情報が無いため取得を飛ばした');
      console.log('    (.env に GSC_SERVICE_ACCOUNT_FILE か GSC_REFRESH_TOKEN を置く。詳細は scripts/gsc.mjs の冒頭)');
    }
    return null;
  }

  const period = window();
  try {
    const { site, totals } = await resolveSite(auth.token, period);
    let row = totals.rows?.[0];
    let dataState = 'final';
    let effective = period;

    /*
     * 確定データが0のとき、未確定(dataState: all)を今日まで含めて取り直す。
     *
     * **表示が付き始めた直後に必要になる。** 確定は2〜3日遅れるので、
     * 開始が7/28で今日が7/30なら、確定だけを見ると窓が7/27で切れて必ず0になり、
     * 「まだ何も起きていない」と読み違える。0が本物かどうかを分けるための問い合わせで、
     * 未確定の数字を使ったときは data_state に残して後から区別できるようにする。
     */
    if (!row || row.impressions === 0) {
      const fresh = { startDate: period.startDate, endDate: iso(new Date()) };
      const alt = await searchAnalytics(site, auth.token, {
        ...fresh,
        dimensions: [],
        dataState: 'all',
      });
      const altRow = alt.rows?.[0];
      if (altRow && altRow.impressions > 0) {
        row = altRow;
        dataState = 'all';
        effective = fresh;
      }
    }

    const [queries, pages] = await Promise.all([
      searchAnalytics(site, auth.token, { ...effective, dataState, dimensions: ['query'], rowLimit: 25 }),
      searchAnalytics(site, auth.token, { ...effective, dataState, dimensions: ['page'], rowLimit: 100 }),
    ]);

    let inspection = null;
    if (FLAGS.inspect) inspection = await indexedCount(site, auth.token);

    return {
      fetched_at: new Date().toISOString(),
      how: auth.how,
      site,
      period: effective,
      /** final = 確定値のみ / all = 未確定の直近を含む(増減の比較には使えない) */
      data_state: dataState,
      /* 0件でも 0 として返す。null は「取れなかった」の意味に限る */
      impressions: row?.impressions ?? 0,
      clicks: row?.clicks ?? 0,
      ctr: row ? Number((row.ctr * 100).toFixed(2)) : 0,
      position: row ? Number(row.position.toFixed(1)) : null,
      top_queries: (queries.rows ?? []).map((r) => ({
        query: r.keys[0],
        impressions: r.impressions,
        clicks: r.clicks,
        position: Number(r.position.toFixed(1)),
      })),
      top_pages: (pages.rows ?? []).slice(0, 20).map((r) => ({
        page: new URL(r.keys[0]).pathname,
        impressions: r.impressions,
        clicks: r.clicks,
        position: Number(r.position.toFixed(1)),
      })),
      pages_with_impressions: (pages.rows ?? []).length,
      inspection,
    };
  } catch (err) {
    if (!quiet) console.error(`  ! Search Console から取れなかった: ${String(err.message).slice(0, 400)}`);
    return null;
  }
}

/**
 * スナップショットの manual 欄に書き込む形へ変換する。
 * 欄の名前は既存の metrics.mjs / qa.mjs と揃える(増やすのは末尾のみ)。
 */
export function toManualFields(gsc) {
  return {
    gsc_indexed: gsc.inspection ? gsc.inspection.indexed : null,
    gsc_impressions_7d: gsc.impressions,
    gsc_clicks_7d: gsc.clicks,
    gsc_avg_position: gsc.position,
    gsc_top_queries: gsc.top_queries.slice(0, 10).map((q) => `${q.query} (${q.impressions}回/${q.position}位)`),
    /** 内訳は後から読み返せるように丸ごと残す。集計値だけだと原因を追えない */
    gsc_detail: {
      fetched_at: gsc.fetched_at,
      site: gsc.site,
      period: gsc.period,
      data_state: gsc.data_state,
      ctr_percent: gsc.ctr,
      pages_with_impressions: gsc.pages_with_impressions,
      top_pages: gsc.top_pages,
      not_indexed: gsc.inspection?.notIndexed ?? null,
    },
  };
}

/* ------------------------------------------------------------ 単体実行 */

function newestSnapshot() {
  if (!existsSync(METRICS_DIR)) return null;
  const files = readdirSync(METRICS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return files.length ? files[files.length - 1] : null;
}

function report(gsc) {
  const p = gsc.period;
  console.log('');
  console.log(`  Search Console  ${p.startDate} 〜 ${p.endDate}  (${gsc.site} / ${gsc.how})`);
  console.log('  ' + '-'.repeat(58));
  if (gsc.data_state === 'all') {
    console.log('  ※ 確定値が0だったため未確定の直近を含めた数字。日を追った増減の比較には使えない');
  }
  console.log(`  表示回数        ${gsc.impressions.toLocaleString('ja-JP')}`);
  console.log(`  クリック数      ${gsc.clicks.toLocaleString('ja-JP')}  (CTR ${gsc.ctr}%)`);
  console.log(`  平均掲載順位    ${gsc.position ?? '—'}`);
  console.log(`  表示のあるページ ${gsc.pages_with_impressions} 件`);
  if (gsc.inspection) {
    const i = gsc.inspection;
    console.log(`  インデックス済み ${i.indexed} / ${i.checked} 件照会${i.total > i.checked ? ` (sitemap ${i.total} 件のうち先頭のみ)` : ''}`);
    for (const n of i.notIndexed.slice(0, 10)) console.log(`    未収録: ${n}`);
    if (i.notIndexed.length > 10) console.log(`    ほか ${i.notIndexed.length - 10} 件`);
  }
  if (gsc.top_queries.length) {
    console.log('  ' + '-'.repeat(58));
    console.log('  上位クエリ');
    for (const q of gsc.top_queries.slice(0, 10)) {
      console.log(`    ${String(q.impressions).padStart(5)}回  ${String(q.position).padStart(5)}位  ${q.query}`);
    }
  } else {
    console.log('  上位クエリ      まだ無い(表示回数が付き始めた直後はここが空になる)');
  }
  console.log('');
}

/** node scripts/gsc.mjs として直接実行されたときだけ動かす */
if (process.argv[1] && process.argv[1].endsWith('gsc.mjs')) {
  const gsc = await fetchSearchConsole();
  if (!gsc) process.exit(0);
  report(gsc);

  if (FLAGS.print) process.exit(0);

  const newest = newestSnapshot();
  if (!newest) {
    console.log('  ! 週次スナップショットが無いため書き込まなかった。`npm run metrics` を先に実行する');
    process.exit(0);
  }
  const path = join(METRICS_DIR, newest);
  const snap = JSON.parse(readFileSync(path, 'utf8'));
  snap.manual = { ...(snap.manual ?? {}), ...toManualFields(gsc) };
  writeFileSync(path, JSON.stringify(snap, null, 2) + '\n', 'utf8');
  console.log(`  metrics/${newest} の manual 欄に書き込んだ(ASP の数字は手入力のまま残る)`);
  console.log('');
}
