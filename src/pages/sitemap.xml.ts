/**
 * sitemap.xml を自前で生成する。
 *
 * @astrojs/sitemap を使わないのは、依存を1つ増やす割に得るものが少ないため。
 * ページ数が数百規模でも、静的ルートを列挙するだけで足りる。
 * noindex ページを除外する判断も自前の方が確実。
 */
import type { APIRoute } from 'astro';
import { entities } from '../lib/entities';
import { guides } from '../lib/guides';

/** 更新頻度の目安。公式統計は年1回更新なので資格ページは monthly で十分 */
const ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  /*
   * 書き込み一覧。中身は実行時にD1から読むためクローラには空に見えるが、
   * **サイトマップから外す理由にはならない。**
   * 静的な説明文とルールは載っており、ここが入口として存在することは伝える。
   * 中身を静的に焼く話は B-035。
   */
  { path: '/board/', changefreq: 'daily', priority: '0.6' },
  { path: '/about/', changefreq: 'monthly', priority: '0.5' },
  { path: '/privacy/', changefreq: 'yearly', priority: '0.2' },
  { path: '/contact/', changefreq: 'yearly', priority: '0.3' },
  { path: '/rules/', changefreq: 'yearly', priority: '0.3' },
];

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://shikaku-log.com')).origin;
  const today = new Date().toISOString().slice(0, 10);

  const urls = [
    ...ROUTES.map((r) => ({ ...r, loc: `${origin}${r.path}` })),
    ...entities.map((e) => ({
      loc: `${origin}/shikaku/${e.slug}/`,
      changefreq: 'weekly',
      priority: '0.8',
    })),
    /*
     * 自己採点ページ。**列挙から漏れていた。**
     * 試験当日に需要が跳ね上がるページなので、当日いきなり順位が付くことはない。
     * 事前にインデックスされていることが前提の設計なのに、sitemapに載せていなかった。
     * 資格ページと同じく entities から生成するので、対象が増えれば自動で載る。
     */
    ...entities
      .filter((e) => e.saiten)
      .map((e) => ({
        loc: `${origin}/shikaku/${e.slug}/saiten/`,
        changefreq: 'weekly',
        priority: '0.7',
      })),
    // 資格をまたぐ比較ページ。src/lib/guides.ts に登録したものが自動で載る
    ...guides.map((g) => ({
      loc: `${origin}${g.path}`,
      changefreq: 'monthly',
      priority: '0.7',
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
