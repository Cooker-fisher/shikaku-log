/**
 * robots.txt を動的に生成する。
 *
 * 静的ファイルにすると Sitemap の絶対URLがドメイン変更時に古いまま残る。
 * 独自ドメインへ移した日に更新を忘れると、Search Console が旧ドメインの
 * sitemap を読みに行って気づきにくい事故になるため、site 設定から組み立てる。
 */
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://shikaku-log.com')).origin;

  const body = `User-agent: *
Allow: /

# 投稿APIはクロール対象にしない
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
