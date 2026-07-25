/**
 * POST /api/report — 合格報告(ユーザー投稿)の受付。
 *
 * 防御(この順で落とす。安いものから先に):
 *   1. メソッド / Content-Type / ボディサイズ
 *   2. Origin 照合(クロスサイトからの POST を拒否)
 *   3. honeypot(ボットだけが埋めるフィールド)
 *   4. 早すぎる送信(フォーム表示からの経過秒数)
 *   5. レートリミット(IPハッシュ単位。60秒に1件 / 24時間に5件)
 *   6. スキーマ検証(型・範囲・文字数)
 *   7. NGワード / スパム判定
 *
 * 保存は必ず status='pending'。公開は人手(または別バッチ)の審査を通す。
 * IPは生で保存しない(ソルト付きSHA-256の先頭16桁のみ)。
 *
 * レスポンス:
 *   - 公開済み投稿が n>=20 の場合のみ「短い方から◯%」を返す
 *   - n<20 の場合は現在の収集件数だけ返す(順位や中央値は一切返さない)
 */

import {
  CERTIFICATION_REPORT_SCHEMA,
  validateReport,
  type ReportSchema,
} from '../../src/lib/validation';
import { moderator } from '../../src/lib/moderation';
import { hashIdentifier, clientIpOf } from '../../src/lib/hash';
import {
  MIN_SAMPLE_SIZE,
  percentileRankOf,
  CERTIFICATION_METRIC_CONFIG,
} from '../../src/lib/metrics';

interface Env {
  DB: D1Database;
  /** 生IPを保存しないためのソルト。未設定なら投稿を受け付けない */
  IP_HASH_SALT?: string;
  /** 任意。設定するとその件数で閾値を上書きできる(通常は使わない) */
  REPORT_MIN_SAMPLE_SIZE?: string;
}

// --- 定数 -------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024;
/** 同一IPハッシュ: 直近この秒数以内に投稿があれば拒否 */
const COOLDOWN_SECONDS = 60;
/** 同一IPハッシュ: 24時間あたりの上限件数 */
const DAILY_LIMIT = 5;
/** フォーム表示から送信までがこれ未満なら機械とみなす */
const MIN_FILL_SECONDS = 4;
/** honeypot のフィールド名(CSSで隠す。人間は絶対に埋めない) */
const HONEYPOT_FIELD = 'website';

const SCHEMAS: Record<string, ReportSchema> = {
  certification: CERTIFICATION_REPORT_SCHEMA,
};

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

function fail(status: number, code: string, message: string, extra?: unknown): Response {
  return json({ ok: false, code, message, ...(extra ? { detail: extra } : {}) }, status);
}

/** クロスサイトからの POST を拒否する(同一オリジンのフォームのみ許可) */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // fetch 以外(古いクライアント)は Origin 無しのことがある
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// --- 本体 -------------------------------------------------------------------

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. 入口のチェック --------------------------------------------------------
  if (!isSameOrigin(request)) {
    return fail(403, 'forbidden_origin', '不正なリクエスト');
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    return fail(415, 'unsupported_media_type', 'JSONで送信すること');
  }
  const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return fail(413, 'payload_too_large', '入力が長すぎる');
  }

  const rawText = await request.text();
  if (rawText.length > MAX_BODY_BYTES) {
    return fail(413, 'payload_too_large', '入力が長すぎる');
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return fail(400, 'bad_request', '形式が不正');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'bad_request', '形式が不正');
  }

  // 2. honeypot -------------------------------------------------------------
  // 埋まっていたらボット。エラーを返すと学習されるので、成功を装って捨てる。
  const honeypot = body[HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return json({ ok: true, status: 'received', sampleSize: 0 });
  }

  // 3. 早すぎる送信 ----------------------------------------------------------
  const formLoadedAt = Number(body['form_loaded_at'] ?? 0);
  if (Number.isFinite(formLoadedAt) && formLoadedAt > 0) {
    const elapsed = (Date.now() - formLoadedAt) / 1000;
    if (elapsed < MIN_FILL_SECONDS) {
      return fail(429, 'too_fast', '送信が早すぎる。もう一度試すこと');
    }
  }

  // 4. 対象 entity の特定 ----------------------------------------------------
  const entityType = typeof body['entity_type'] === 'string' ? body['entity_type'] : 'certification';
  const entitySlug = typeof body['entity_slug'] === 'string' ? body['entity_slug'] : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entitySlug)) {
    return fail(400, 'bad_entity', '対象が不正');
  }
  const schema = SCHEMAS[entityType];
  if (!schema) {
    return fail(400, 'bad_entity', '対象が不正');
  }

  if (!env.DB) {
    return fail(503, 'db_unavailable', '現在受け付けできない');
  }

  const entity = await env.DB.prepare('SELECT id FROM entities WHERE type = ? AND slug = ? LIMIT 1')
    .bind(entityType, entitySlug)
    .first<{ id: number }>();
  if (!entity) {
    return fail(404, 'entity_not_found', '対象が見つからない');
  }

  // 5. IP / UA のハッシュ化(生値は保存しない) --------------------------------
  const salt = env.IP_HASH_SALT ?? '';
  let ipHash: string;
  let uaHash: string;
  try {
    const ip = clientIpOf(request);
    const ua = request.headers.get('User-Agent') ?? '';
    ipHash = await hashIdentifier(ip, salt, 'ip');
    uaHash = await hashIdentifier(ua, salt, 'ua');
  } catch {
    // ソルト未設定。ハッシュ化できないなら受け付けない(生IP保存への退避はしない)
    console.error('IP_HASH_SALT is not configured');
    return fail(503, 'not_configured', '現在受け付けできない');
  }

  // 6. レートリミット --------------------------------------------------------
  const recent = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS in_cooldown,
       SUM(CASE WHEN created_at >= ?3 THEN 1 ELSE 0 END) AS in_day
     FROM reports
     WHERE ip_hash = ?1`,
  )
    .bind(ipHash, isoSecondsAgo(COOLDOWN_SECONDS), isoSecondsAgo(86400))
    .first<{ in_cooldown: number | null; in_day: number | null }>();

  if ((recent?.in_cooldown ?? 0) > 0) {
    return fail(429, 'rate_limited', '短時間に複数の投稿はできない', {
      retryAfterSeconds: COOLDOWN_SECONDS,
    });
  }
  if ((recent?.in_day ?? 0) >= DAILY_LIMIT) {
    return fail(429, 'rate_limited', '1日の投稿上限に達している');
  }

  // 7. スキーマ検証 + NGワード ------------------------------------------------
  const validation = validateReport(body['payload'] ?? body, schema, moderator);
  if (!validation.ok) {
    return fail(422, 'validation_failed', '入力を確認すること', validation.errors);
  }
  const payload = validation.value;

  // 8. 保存(必ず pending) ---------------------------------------------------
  await env.DB.prepare(
    `INSERT INTO reports (entity_id, payload, status, created_at, ip_hash, user_agent_hash)
     VALUES (?1, ?2, 'pending', ?3, ?4, ?5)`,
  )
    .bind(entity.id, JSON.stringify(payload), nowIso(), ipHash, uaHash)
    .run();

  // 9. 返却する情報 ----------------------------------------------------------
  // 公開済みの母集団のみを使う。n<20 なら順位は返さない(metrics.ts が強制する)。
  const published = await env.DB.prepare(
    `SELECT json_extract(payload, '$.study_hours') AS study_hours
       FROM reports
      WHERE entity_id = ?1 AND status = 'published'`,
  )
    .bind(entity.id)
    .all<{ study_hours: number | null }>();

  const values = (published.results ?? []).map((row) => row.study_hours);
  const rank = percentileRankOf(
    values,
    payload['study_hours'],
    CERTIFICATION_METRIC_CONFIG.numeric?.['study_hours'],
  );

  if (rank.status === 'ready') {
    return json({
      ok: true,
      status: 'received',
      message: '投稿を受け付けた。内容の確認後に公開する。',
      sampleSize: rank.sampleSize,
      percentile: rank.percentile,
      percentileMessage: `公開済み${rank.sampleSize}件の自己申告のうち、勉強時間が短い方から約${rank.percentile}%の位置。`,
    });
  }

  return json({
    ok: true,
    status: 'received',
    message: '投稿を受け付けた。内容の確認後に公開する。',
    sampleSize: rank.sampleSize,
    minSampleSize: MIN_SAMPLE_SIZE,
    collectingMessage: `現在の公開済みは${rank.sampleSize}件。${MIN_SAMPLE_SIZE}件に達するまで集計は出さない。`,
  });
};

/**
 * POST 以外は Pages が自動で 405 を返す(ハンドラを定義しないことが閉じる意思表示)。
 * OPTIONS だけは明示的に許可メソッドを返す。
 */
export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
