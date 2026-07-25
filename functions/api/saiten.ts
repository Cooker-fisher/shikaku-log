/**
 * /api/saiten — 自己採点(選択肢の分布集計)。設計の根拠は decisions/013-自己採点ツールの設計.md
 *
 *   GET  ?exam=takken-2026   集計を返す(エッジで60秒キャッシュ)
 *   POST                      解答を投稿し、多数派との一致数を返す
 *
 * **このAPIは正解を持たない。**受験者が選んだ選択肢を数えるだけである。
 * 設問文も選択肢の文言も受け取らないし保存しない(著作権に触れないための設計)。
 * 得点も合否も返さない。返すのは「多数派と何問一致したか」だけで、
 * それが得点ではないことはUI側で明記する。
 *
 * **D1無料枠(1日 書込10万行)で捌くための構造**:
 *  - 投稿は1件=1行(解答は "31424..." の文字列)
 *  - 集計は saiten_tally の**1行**にJSONで持つ。問ごとに集計行を持つと
 *    1投稿=50行の書込になり、1万投稿で無料枠の5倍を使ってしまう
 *  - TALLY_BATCH 件たまるごとに差分だけ集計し、**楽観ロック**で1行を更新する
 */

import { hashIdentifier, clientIpOf } from '../../src/lib/hash';

interface Env {
  DB: D1Database;
  IP_HASH_SALT?: string;
}

// --- 定数 -------------------------------------------------------------------

const MAX_BODY_BYTES = 4 * 1024;
/** 一般受験者の問題数。登録講習修了者は問46〜50が免除される */
const QUESTIONS_GENERAL = 50;
const QUESTIONS_EXEMPT = 45;
/** 選択肢は四肢択一。'0' は未回答 */
const CHOICES = 4;
/** この件数たまるごとに集計を更新する。小さくすると鮮度が上がるが書込が増える */
const TALLY_BATCH = 100;
/** 集計レスポンスのエッジキャッシュ秒数。D1の読取を1日1,440回程度に抑える */
const CACHE_SECONDS = 60;
/** 同一IPハッシュ: 直近この秒数以内の投稿は拒否 */
const COOLDOWN_SECONDS = 30;
/** 同一IPハッシュ: 1つの試験に対する上限投稿数 */
const PER_EXAM_LIMIT = 3;
const MIN_FILL_SECONDS = 20;
const HONEYPOT_FIELD = 'website';

/**
 * 受け付ける試験。ここに無いものは404。
 *
 * `opensAt` は投稿を受け付け始める時刻(ISO8601)。**試験終了時刻より前は受け付けない。**
 * 試験中に解答が流出する経路を作らないためと、当日に手でデプロイして開放する運用に
 * しないため(その運用は担当が寝坊した瞬間に年1回の機会を失う)。
 * サーバ側で守るので、クライアントのJSが壊れていても早期投稿は通らない。
 */
const EXAMS: Record<string, { general: number; exempt: number | null; opensAt: string }> = {
  // 令和8年度宅建試験。試験時間は13:00〜15:00(JST)。15:00 JST = 06:00 UTC
  'takken-2026': { general: QUESTIONS_GENERAL, exempt: QUESTIONS_EXEMPT, opensAt: '2026-10-18T06:00:00Z' },
};

type Counts = Record<string, number[]>;

// --- ヘルパー ---------------------------------------------------------------

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json({ ok: false, code, message }, status);
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function emptyCounts(): Counts {
  return {};
}

/** 解答文字列を集計に足しこむ。'0'(未回答)は数えない */
function accumulate(counts: Counts, answers: string): void {
  for (let i = 0; i < answers.length; i += 1) {
    const c = answers.charCodeAt(i) - 48; // '0' = 48
    if (c < 1 || c > CHOICES) continue;
    const key = String(i + 1);
    const row = counts[key] ?? (counts[key] = new Array(CHOICES).fill(0));
    row[c - 1] += 1;
  }
}

/** 各問の最多選択肢(1〜4)。同数のときは決めない(null) */
function majorityOf(counts: Counts): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [q, row] of Object.entries(counts)) {
    const max = Math.max(...row);
    if (max === 0) {
      out[q] = null;
      continue;
    }
    const winners = row.filter((v) => v === max).length;
    out[q] = winners === 1 ? row.indexOf(max) + 1 : null;
  }
  return out;
}

// --- 集計の更新 -------------------------------------------------------------

/**
 * 未反映の投稿を集計に取り込む。
 *
 * 楽観ロック: upto_id が読んだ時と同じ場合だけ書き込む。
 * 0行更新なら他のリクエストが先に処理しているので、何もせず終える。
 * 二重計上も取りこぼしも起こさない。
 *
 * 失敗しても投稿自体は成功扱いにする(saiten_submissions が真の記録であり、
 * 集計はそこから何度でも作り直せる)。
 */
async function advanceTally(db: D1Database, examKey: string): Promise<void> {
  const tally = await db
    .prepare('SELECT counts_json, upto_id, submissions FROM saiten_tally WHERE exam_key = ?')
    .bind(examKey)
    .first<{ counts_json: string; upto_id: number; submissions: number }>();
  if (!tally) return;

  const rows = await db
    .prepare('SELECT id, answers FROM saiten_submissions WHERE exam_key = ? AND id > ? ORDER BY id LIMIT 2000')
    .bind(examKey, tally.upto_id)
    .all<{ id: number; answers: string }>();

  const list = rows.results ?? [];
  const last = list[list.length - 1];
  if (list.length < TALLY_BATCH || !last) return;

  let counts: Counts;
  try {
    counts = JSON.parse(tally.counts_json) as Counts;
  } catch {
    counts = emptyCounts();
  }
  for (const r of list) accumulate(counts, r.answers);

  await db
    .prepare(
      `UPDATE saiten_tally
          SET counts_json = ?, upto_id = ?, submissions = ?, updated_at = datetime('now')
        WHERE exam_key = ? AND upto_id = ?`,
    )
    .bind(JSON.stringify(counts), last.id, tally.submissions + list.length, examKey, tally.upto_id)
    .run();
}

// --- GET --------------------------------------------------------------------

async function handleGet(context: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  const { request, env } = context;
  const examKey = new URL(request.url).searchParams.get('exam') ?? '';
  if (!EXAMS[examKey]) return fail(404, 'exam_not_found', '対象の試験が見つからない');
  if (!env.DB) return fail(503, 'db_unavailable', '現在利用できない');

  const tally = await env.DB.prepare(
    'SELECT counts_json, submissions, updated_at FROM saiten_tally WHERE exam_key = ?',
  )
    .bind(examKey)
    .first<{ counts_json: string; submissions: number; updated_at: string }>();

  if (!tally) return fail(404, 'exam_not_found', '対象の試験が見つからない');

  return json(
    {
      ok: true,
      exam: examKey,
      submissions: tally.submissions,
      counts: JSON.parse(tally.counts_json),
      updated_at: tally.updated_at,
      opens_at: EXAMS[examKey]?.opensAt,
      open: Date.now() >= Date.parse(EXAMS[examKey]!.opensAt),
      // 「これは得点ではない」ことはUIだけでなくAPIの返り値にも書いておく。
      // 他所がこのデータを引用するときに文脈ごと持っていけるようにする。
      disclaimer: '受験者の自己申告による選択肢の分布です。正解ではありません。',
    },
    200,
    { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
  );
}

// --- POST -------------------------------------------------------------------

async function handlePost(context: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  const { request, env } = context;

  if (!isSameOrigin(request)) return fail(403, 'forbidden_origin', '不正なリクエスト');
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) {
    return fail(415, 'unsupported_media_type', 'JSONで送信すること');
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'payload_too_large', '入力が長すぎる');

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return fail(400, 'bad_request', '形式が不正');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'bad_request', '形式が不正');
  }

  // honeypot は成功を装って捨てる(エラーを返すと学習されるため)
  const honeypot = body[HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return json({ ok: true, status: 'received', submissions: 0, matched: 0, comparable: 0 });
  }

  const formLoadedAt = Number(body['form_loaded_at'] ?? 0);
  if (Number.isFinite(formLoadedAt) && formLoadedAt > 0) {
    if ((Date.now() - formLoadedAt) / 1000 < MIN_FILL_SECONDS) {
      return fail(429, 'too_fast', '送信が早すぎる。もう一度試すこと');
    }
  }

  const examKey = typeof body['exam'] === 'string' ? body['exam'] : '';
  const exam = EXAMS[examKey];
  if (!exam) return fail(404, 'exam_not_found', '対象の試験が見つからない');

  if (Date.now() < Date.parse(exam.opensAt)) {
    return fail(423, 'not_open_yet', '試験終了後に受け付けを開始する');
  }

  /**
   * 受験区分は**統計として記録するだけ**で、解答の長さには影響させない。
   *
   * 「登録講習修了者は45問」であることは公表されているが、
   * **どの5問が免除されるかは一次ソースで確認できていない**。番号を決め打ちすると
   * 前提が違っていた場合に分布が壊れるため、全員から問1〜50を受け取り、
   * 免除された問題は未回答('0')として送ってもらう。空欄は集計に数えない。
   * これならどの5問が免除でも結果は正しい。
   */
  const answerSet = body['answer_set'] === 'exempt' ? 'exempt' : 'general';
  const expected = exam.general;

  const answers = typeof body['answers'] === 'string' ? body['answers'] : '';
  if (answers.length !== expected || !/^[0-4]+$/.test(answers)) {
    return fail(400, 'bad_answers', `解答は${expected}問ぶんで、各問1〜4(未回答は0)で送ること`);
  }
  const answered = [...answers].filter((c) => c !== '0').length;
  if (answered === 0) return fail(400, 'no_answers', '1問も入力されていない');

  if (!env.DB) return fail(503, 'db_unavailable', '現在受け付けできない');

  // IPは生で保存しない。ソルト未設定なら受け付けない(生IP保存への退避はしない)
  let ipHash: string;
  try {
    ipHash = await hashIdentifier(clientIpOf(request), env.IP_HASH_SALT ?? '', 'ip');
  } catch {
    console.error('IP_HASH_SALT is not configured');
    return fail(503, 'not_configured', '現在受け付けできない');
  }

  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM saiten_submissions WHERE exam_key = ? AND ip_hash = ? AND created_at > ?',
  )
    .bind(examKey, ipHash, isoSecondsAgo(COOLDOWN_SECONDS))
    .first<{ n: number }>();
  if ((recent?.n ?? 0) > 0) return fail(429, 'too_many_requests', '少し時間をおいて試すこと');

  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM saiten_submissions WHERE exam_key = ? AND ip_hash = ?',
  )
    .bind(examKey, ipHash)
    .first<{ n: number }>();
  if ((total?.n ?? 0) >= PER_EXAM_LIMIT) {
    return fail(429, 'limit_reached', 'この試験への送信は上限に達している');
  }

  await env.DB.prepare(
    'INSERT INTO saiten_submissions (exam_key, answer_set, answers, answered, ip_hash) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(examKey, answerSet, answers, answered, ipHash)
    .run();

  // 集計の更新は投稿の成否に影響させない
  try {
    await advanceTally(env.DB, examKey);
  } catch (err) {
    console.error('advanceTally failed', err);
  }

  // 多数派との一致数を返す。**これは得点ではない。**
  const tally = await env.DB.prepare('SELECT counts_json, submissions FROM saiten_tally WHERE exam_key = ?')
    .bind(examKey)
    .first<{ counts_json: string; submissions: number }>();

  let matched = 0;
  let comparable = 0;
  if (tally && tally.submissions > 0) {
    let counts: Counts;
    try {
      counts = JSON.parse(tally.counts_json) as Counts;
    } catch {
      counts = emptyCounts();
    }
    const majority = majorityOf(counts);
    for (let i = 0; i < answers.length; i += 1) {
      const mine = answers.charCodeAt(i) - 48;
      if (mine < 1 || mine > CHOICES) continue;
      const maj = majority[String(i + 1)];
      if (maj === null || maj === undefined) continue;
      comparable += 1;
      if (maj === mine) matched += 1;
    }
  }

  return json({
    ok: true,
    status: 'received',
    answered,
    /** 多数派と一致した問題数 */
    matched,
    /** 多数派が確定していて比較できた問題数(matched の分母) */
    comparable,
    /** 集計に反映済みの投稿数。母数として必ず併記させる */
    submissions: tally?.submissions ?? 0,
    disclaimer: '多数派との一致数であり、得点でも合否でもありません。多数派が正しいとは限りません。',
  });
}

// --- ルーティング -----------------------------------------------------------

export const onRequest: PagesFunction<Env> = async (context) => {
  switch (context.request.method) {
    case 'GET':
      return handleGet(context);
    case 'POST':
      return handlePost(context);
    case 'OPTIONS':
      return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS' } });
    default:
      return json({ ok: false, code: 'method_not_allowed' }, 405, { Allow: 'GET, POST, OPTIONS' });
  }
};
