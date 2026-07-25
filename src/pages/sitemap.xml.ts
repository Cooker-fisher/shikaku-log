/**
 * sitemap.xml を自前で生成する。
 *
 * @astrojs/sitemap を使わないのは、依存を1つ増やす割に得るものが少ないため。
 * ページ数が数百規模でも、静的ルートを列挙するだけで足りる。
 * noindex ページを除外する判断も自前の方が確実。
 */
import type { APIRoute } from 'astro';
import { entities } from '../lib/entities';

/** 更新頻度の目安。公式統計は年1回更新なので資格ページは monthly で十分 */
const ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/about/', changefreq: 'monthly', priority: '0.5' },
  { path: '/privacy/', changefreq: 'yearly', priority: '0.2' },
  { path: '/contact/', changefreq: 'yearly', priority: '0.3' },
];

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://shikakulog.pages.dev')).origin;
  const today = new Date().toISOString().slice(0, 10);

  const urls = [
    ...ROUTES.map((r) => ({ ...r, loc: `${origin}${r.path}` })),
    ...entities.map((e) => ({
      loc: `${origin}/shikaku/${e.slug}/`,
      changefreq: 'weekly',
      priority: '0.8',
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
