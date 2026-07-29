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

/**
 * 1行を表示用の形に直す。
 * **モジュール直下に置く。**ハンドラ内の const にしていたため、
 * 全資格を横断する分岐(先に走る)から参照できず ReferenceError になっていた。
 */
function parse(row: Row) {
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
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== 'GET') {
    return json({ ok: false, code: 'method_not_allowed' }, 405);
  }

  const params = new URL(context.request.url).searchParams;
  const slug = params.get('slug') ?? '';

  if (!context.env.DB) return json({ ok: false, code: 'db_unavailable' }, 503);

  /**
   * ============================================================
   * 全資格を横断して引く(slug を付けずに呼ぶ)
   * ============================================================
   * **なぜ要るか(2026-07-28)**
   * このAPIは entity_id で厳密に絞る作りしか持たず、
   * 「サイト全体でいま何が書かれているか」を知る手段が無かった。
   *
   * その結果として起きていたこと:
   * 1. 資格ページ17枚が、それぞれ自分の投稿だけを見に行く。
   *    総数が少ないうちは**17枚すべてが「まだ書き込みはありません」**を出す
   * 2. **答える側が戻ってくる場所が無い。**
   *    集めているのは「詰まっている勉強中の人」= 質問者だけで、
   *    分かる人が「どこかに未回答の質問があるはずだ」と思っても、
   *    17枚を1枚ずつ開いて確かめる以外の方法が無かった。
   *    通知もアカウントも持たない設計なので、**戻る先のURLが唯一の再訪経路**になる
   *
   * `unanswered=1` を付けると、返信が1件も付いていないものだけを返す。
   */
  if (!slug) {
    const onlyUnanswered = params.get('unanswered') === '1';
    const rows = await context.env.DB.prepare(
      `SELECT r.id, r.kind, r.parent_id, r.payload, r.handle, r.created_at,
              e.slug AS entity_slug, e.name AS entity_name,
              (SELECT COUNT(*) FROM reports c
                WHERE c.parent_id = r.id AND c.kind = 'reply' AND c.status = 'published') AS reply_count
         FROM reports r
         JOIN entities e ON e.id = r.entity_id
        WHERE r.kind = 'thread' AND r.status = 'published'
        ORDER BY r.created_at DESC
        LIMIT ?1`,
    )
      .bind(MAX_THREADS)
      .all<Row & { entity_slug: string; entity_name: string; reply_count: number }>();

    const items = (rows.results ?? [])
      .filter((r) => !onlyUnanswered || r.reply_count === 0)
      .map((r) => {
        const p = parse(r);
        return {
          id: p.id,
          handle: p.handle,
          body: p.body,
          statusLabel: p.statusLabel,
          createdAt: p.createdAt,
          replyCount: r.reply_count,
          slug: r.entity_slug,
          name: r.entity_name,
        };
      });

    return json(
      {
        ok: true,
        scope: 'all',
        threadCount: items.length,
        unansweredCount: items.filter((i) => i.replyCount === 0).length,
        items,
      },
      200,
      'public, max-age=15',
    );
  }

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    return json({ ok: false, code: 'bad_entity' }, 400);
  }

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

  /**
   * **ほかの資格の最近の書き込み(2026-07-28 追加)。**
   *
   * それまでこのAPIは entity_id で厳密に絞っており、**サイト全体を見る手段が無かった。**
   * 資格ページは17枚あるので、投稿の総数が少ないうちは
   * **17枚すべてが「まだ書き込みはありません」を表示する。**
   * 投稿という希少な資源を17分割すれば、どのページも永遠に過疎に見える。
   * 最初の数人にとっては「誰も居ない場所に最初の1件を書け」と言われるのと同じで、
   * これは書き込みが集まらない設計そのものだった。
   *
   * この資格の書き込みが少ないときだけ、他資格の直近の書き込みを添える。
   * **混ぜて表示しない。**別の見出しの下に、資格名を付けて出すのは表示側の責任。
   */
  const QUIET = 3;
  let elsewhere: unknown[] = [];
  if (threads.size < QUIET) {
    const others = await context.env.DB.prepare(
      `SELECT r.id, r.payload, r.handle, r.created_at, e.slug, e.name
         FROM reports r
         JOIN entities e ON e.id = r.entity_id
        WHERE r.kind = 'thread'
          AND r.status = 'published'
          AND r.entity_id <> ?1
        ORDER BY r.created_at DESC
        LIMIT 5`,
    )
      .bind(entity.id)
      .all<Row & { slug: string; name: string }>();

    elsewhere = (others.results ?? []).map((row) => {
      const p = parse(row);
      return { id: p.id, handle: p.handle, body: p.body, createdAt: p.createdAt, slug: row.slug, name: row.name };
    });
  }

  return json(
    {
      ok: true,
      slug,
      threadCount: threads.size,
      postCount: all.length,
      /** 返信が付いていないスレッドの数。「答えられる場所」を示すために使う */
      unansweredCount: list.filter((t) => t.replies.length === 0).length,
      threads: list,
      elsewhere,
    },
    200,
    // 投稿直後に自分の書き込みが見えないと「消えた」と思われる。短命なキャッシュに留める
    'public, max-age=15',
  );
};
