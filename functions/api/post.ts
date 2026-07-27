/**
 * POST /api/post — 勉強中の人の書き込み(thread)と、その返信(reply)の受付。
 *
 * `/api/report`(合格報告)との違いは**誰が書けるか**である。
 * 合格報告は合格した人しか書けない。しかし「危険物乙4 勉強時間」を検索するのは
 * **受験前の人**であり、合格者ではない。入口と出口で対象者が一致していなかった(ADR-016)。
 * こちらは受験前・勉強中の人が主役で、合格者も書ける。
 *
 * **公開は機械判定で自動的に行う。**
 * 全件を人が見る設計は、投稿が増えた瞬間に破綻する。
 * 判定は `classifyPost()`(決定論的な正規表現のみ。LLMを1件も通さない):
 *   reject … 保存しない。理由をその場で返し、直して出し直してもらう
 *   hold   … 保存するが公開しない。人が見るまで出ない
 *   ok     … そのまま公開する
 *
 * 防御は /api/report と同じ順序で、安いものから落とす。
 * IPは生で保存しない(ソルト付きSHA-256の先頭のみ)。
 */

import { classifyPost } from '../../src/lib/moderation';
import { hashIdentifier, clientIpOf } from '../../src/lib/hash';

interface Env {
  DB: D1Database;
  /** 生IPを保存しないためのソルト。未設定なら投稿を受け付けない */
  IP_HASH_SALT?: string;
}

// --- 定数 -------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024;

/**
 * 合格報告(60秒/5件)より緩い。
 * 議論は往復するものなので、同じ制限をかけると会話が成立しない。
 * ただし無制限にはしない。荒らしの投下速度を落とすのが目的である。
 */
const COOLDOWN_SECONDS = 20;
const DAILY_LIMIT = 20;

/** フォーム表示から送信までがこれ未満なら機械とみなす */
const MIN_FILL_SECONDS = 3;
const HONEYPOT_FIELD = 'website';

/** 投稿者の状況。ここを1タップに固定することで、書かれる内容が決まる */
const STATUS_TAGS = {
  before: 'これから始める',
  studying: '勉強中',
  taken: '受験済み',
} as const;
type StatusTag = keyof typeof STATUS_TAGS;

const MAX_HANDLE_LENGTH = 16;

// --- ヘルパー ---------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function fail(status: number, code: string, message: string, extra?: unknown): Response {
  return json({ ok: false, code, message, ...(extra ? { detail: extra } : {}) }, status);
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

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoSecondsAgo = (s: number) =>
  new Date(Date.now() - s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * 表示名の正規化。
 * 空なら「名無し」。**アカウントは作らせない**(掟2: 登録できるのはオーナーだけ)。
 * 他人になりすませないよう、運営を騙る名前だけは弾く。
 */
function normalizeHandle(raw: unknown): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: true, value: null };
  const name = raw.replace(/[​-‍﻿\p{Cc}]/gu, '').trim();
  if (name === '') return { ok: true, value: null };
  if ([...name].length > MAX_HANDLE_LENGTH) {
    return { ok: false, reason: `名前は${MAX_HANDLE_LENGTH}文字までです` };
  }
  if (/(運営|管理人|admin|シカクログ|公式)/i.test(name)) {
    return { ok: false, reason: 'その名前は使えません' };
  }
  return { ok: true, value: name };
}

/** 制御文字を除き、連続する空行を潰す。表示側のエスケープとは別に入口でも削る */
function sanitizeBody(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[​-‍﻿]/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- 本体 -------------------------------------------------------------------

export const onRequest: PagesFunction<Env> = async (context) => {
  switch (context.request.method) {
    case 'POST':
      return handlePost(context);
    case 'OPTIONS':
      return new Response(null, { status: 204, headers: { Allow: 'POST, OPTIONS' } });
    default:
      return json({ ok: false, code: 'method_not_allowed' }, 405);
  }
};

const handlePost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. 入口 ------------------------------------------------------------------
  if (!isSameOrigin(request)) return fail(403, 'forbidden_origin', '不正なリクエスト');
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) {
    return fail(415, 'unsupported_media_type', 'JSONで送信すること');
  }
  const rawText = await request.text();
  if (rawText.length > MAX_BODY_BYTES) return fail(413, 'payload_too_large', '入力が長すぎる');

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

  // 2. honeypot(埋まっていたらボット。成功を装って捨てる) ---------------------
  const honeypot = body[HONEYPOT_FIELD];
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return json({ ok: true, status: 'received' });
  }

  // 3. 早すぎる送信 ----------------------------------------------------------
  const formLoadedAt = Number(body['form_loaded_at'] ?? 0);
  if (Number.isFinite(formLoadedAt) && formLoadedAt > 0) {
    if ((Date.now() - formLoadedAt) / 1000 < MIN_FILL_SECONDS) {
      return fail(429, 'too_fast', '送信が早すぎます。もう一度試してください');
    }
  }

  // 4. 種類と対象 ------------------------------------------------------------
  const kind = body['kind'] === 'reply' ? 'reply' : 'thread';
  const entitySlug = typeof body['entity_slug'] === 'string' ? body['entity_slug'] : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entitySlug)) return fail(400, 'bad_entity', '対象が不正');

  if (!env.DB) return fail(503, 'db_unavailable', '現在受け付けできません');

  const entity = await env.DB.prepare(
    'SELECT id FROM entities WHERE type = ? AND slug = ? LIMIT 1',
  )
    .bind('certification', entitySlug)
    .first<{ id: number }>();
  if (!entity) return fail(404, 'entity_not_found', '対象が見つかりません');

  // 5. 返信なら、親が実在し公開されていること --------------------------------
  let parentId: number | null = null;
  if (kind === 'reply') {
    const raw = Number(body['parent_id']);
    if (!Number.isInteger(raw) || raw <= 0) return fail(400, 'bad_parent', '返信先が不正です');
    const parent = await env.DB.prepare(
      `SELECT id FROM reports
        WHERE id = ?1 AND entity_id = ?2 AND kind = 'thread' AND status = 'published'
        LIMIT 1`,
    )
      .bind(raw, entity.id)
      .first<{ id: number }>();
    // 非公開の投稿に返信できると、公開前の内容の存在が外から分かってしまう
    if (!parent) return fail(404, 'parent_not_found', '返信先が見つかりません');
    parentId = parent.id;
  }

  // 6. 状況タグ(threadのみ必須) ---------------------------------------------
  let statusTag: StatusTag | null = null;
  if (kind === 'thread') {
    const tag = body['status_tag'];
    if (typeof tag !== 'string' || !(tag in STATUS_TAGS)) {
      return fail(422, 'bad_status_tag', 'いまの状況を選んでください');
    }
    statusTag = tag as StatusTag;
  }

  // 7. 表示名 ----------------------------------------------------------------
  const handle = normalizeHandle(body['handle']);
  if (!handle.ok) return fail(422, 'bad_handle', handle.reason);

  // 8. IP / UA のハッシュ化(生値は保存しない) --------------------------------
  const salt = env.IP_HASH_SALT ?? '';
  let ipHash: string;
  let uaHash: string;
  try {
    ipHash = await hashIdentifier(clientIpOf(request), salt, 'ip');
    uaHash = await hashIdentifier(request.headers.get('User-Agent') ?? '', salt, 'ua');
  } catch {
    console.error('IP_HASH_SALT is not configured');
    return fail(503, 'not_configured', '現在受け付けできません');
  }

  // 9. レートリミット(自由投稿だけを数える) ----------------------------------
  const recent = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS in_cooldown,
       SUM(CASE WHEN created_at >= ?3 THEN 1 ELSE 0 END) AS in_day
     FROM reports
     WHERE ip_hash = ?1 AND kind IN ('thread','reply')`,
  )
    .bind(ipHash, isoSecondsAgo(COOLDOWN_SECONDS), isoSecondsAgo(86400))
    .first<{ in_cooldown: number | null; in_day: number | null }>();

  if ((recent?.in_cooldown ?? 0) > 0) {
    return fail(429, 'rate_limited', `続けて投稿はできません。${COOLDOWN_SECONDS}秒ほど待ってください`);
  }
  if ((recent?.in_day ?? 0) >= DAILY_LIMIT) {
    return fail(429, 'rate_limited', '1日の投稿上限に達しました');
  }

  // 10. 本文の判定(ここが公開/保留/拒否を決める) ------------------------------
  const text = sanitizeBody(body['body']);
  const verdict = classifyPost(text);
  if (verdict.severity === 'reject') {
    return fail(422, 'rejected', verdict.reason ?? '投稿できない内容が含まれています');
  }
  const willPublish = verdict.severity === 'ok';

  // 11. 保存 -----------------------------------------------------------------
  const payload = statusTag ? { body: text, status_tag: statusTag } : { body: text };
  const now = nowIso();
  const inserted = await env.DB.prepare(
    `INSERT INTO reports
       (entity_id, kind, parent_id, payload, handle, status, published_at, published_by,
        created_at, ip_hash, user_agent_hash, review_note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     RETURNING id`,
  )
    .bind(
      entity.id,
      kind,
      parentId,
      JSON.stringify(payload),
      handle.value,
      willPublish ? 'published' : 'pending',
      willPublish ? now : null,
      willPublish ? 'auto' : null,
      now,
      ipHash,
      uaHash,
      verdict.rule ?? null,
    )
    .first<{ id: number }>();

  // 12. 返却 -----------------------------------------------------------------
  if (!willPublish) {
    return json({
      ok: true,
      status: 'pending',
      message: '内容を確認したうえで公開します。試験問題そのものは掲載できないため、確認に時間がかかることがあります。',
    });
  }

  return json({
    ok: true,
    status: 'published',
    post: {
      id: inserted?.id ?? null,
      kind,
      parentId,
      handle: handle.value,
      statusTag,
      statusLabel: statusTag ? STATUS_TAGS[statusTag] : null,
      body: text,
      createdAt: now,
    },
  });
};
