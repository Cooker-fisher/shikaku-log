/**
 * GET /api/posts?slug=<資格のslug> — 公開済みの書き込みと返信を返す。
 *
 * **なぜ読み出しAPIが要るか**
 * このサイトは静的生成で、合格報告はビルド時のスナップショットを埋め込んでいる。
 * 同じ作りを議論欄に使うと、**書き込んでも次のデプロイまで画面に出ない。**
 * 「投稿しても何も起きない」は、最初の数人を必ず失う。
 * 議論だけは実行時に取りに行く。
 *
 * 出さないもの: ip_hash / user_agent_hash / review_note / pending の投稿。
 * 個人を追跡できるIDも出さない(表示用の連番だけ)。
 */

interface Env {
  DB: D1Database;
}

/** 1資格あたりの取得上限。増えたらページングを足す */
const MAX_THREADS = 50;
const MAX_REPLIES_PER_THREAD = 100;

const STATUS_LABELS: Record<string, string> = {
  before: 'これから始める',
  studying: '勉強中',
  taken: '受験済み',
};

interface Row {
  id: number;
  kind: string;
  parent_id: number | null;
  payload: string;
  handle: string | null;
  created_at: string;
}

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'GET') {
    return json({ ok: false, code: 'method_not_allowed' }, 405);
  }

  const slug = new URL(context.request.url).searchParams.get('slug') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    return json({ ok: false, code: 'bad_entity' }, 400);
  }
  if (!context.env.DB) return json({ ok: false, code: 'db_unavailable' }, 503);

  const entity = await context.env.DB.prepare(
    'SELECT id FROM entities WHERE type = ? AND slug = ? LIMIT 1',
  )
    .bind('certification', slug)
    .first<{ id: number }>();
  if (!entity) return json({ ok: false, code: 'entity_not_found' }, 404);

  /*
   * thread と reply をまとめて1回で引く。
   * 件数が少ないうちに N+1 を作ると、増えたときに気づけない。
   */
  const rows = await context.env.DB.prepare(
    `SELECT id, kind, parent_id, payload, handle, created_at
       FROM reports
      WHERE entity_id = ?1
        AND kind IN ('thread','reply')
        AND status = 'published'
      ORDER BY created_at ASC
      LIMIT ?2`,
  )
    .bind(entity.id, MAX_THREADS * (MAX_REPLIES_PER_THREAD + 1))
    .all<Row>();

  const parse = (row: Row) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      /* 壊れた行は本文なしで返す。落とすと一覧全体が消える */
    }
    const tag = typeof payload['status_tag'] === 'string' ? payload['status_tag'] : null;
    return {
      id: row.id,
      handle: row.handle,
      body: typeof payload['body'] === 'string' ? payload['body'] : '',
      statusTag: tag,
      statusLabel: tag ? (STATUS_LABELS[tag] ?? null) : null,
      createdAt: row.created_at,
      replies: [] as unknown[],
    };
  };

  const all = rows.results ?? [];
  const threads = new Map<number, ReturnType<typeof parse>>();
  for (const row of all) {
    if (row.kind === 'thread') threads.set(row.id, parse(row));
  }
  for (const row of all) {
    if (row.kind !== 'reply' || row.parent_id === null) continue;
    const parent = threads.get(row.parent_id);
    if (!parent) continue; // 親が非公開に戻された場合。返信も出さない
    if (parent.replies.length >= MAX_REPLIES_PER_THREAD) continue;
    parent.replies.push(parse(row));
  }

  /** 新しい書き込みが上。返信は古い順(会話の流れが読める向き) */
  const list = [...threads.values()].reverse().slice(0, MAX_THREADS);

  return json(
    {
      ok: true,
      slug,
      threadCount: threads.size,
      postCount: all.length,
      threads: list,
    },
    200,
    // 投稿直後に自分の書き込みが見えないと「消えた」と思われる。短命なキャッシュに留める
    'public, max-age=15',
  );
};
