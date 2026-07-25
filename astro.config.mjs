// @ts-check
import { defineConfig } from 'astro/config';

/**
 * 静的生成のみ。動的処理(投稿受付・集計)は Cloudflare Pages Functions (`functions/`) が担う。
 *
 * Cloudflare アダプタ(@astrojs/cloudflare)は意図的に入れていない。
 * アダプタは `dist/_worker.js` を出力し、その存在によって Cloudflare Pages は
 * `functions/` ディレクトリを**丸ごと無視する**(advanced mode)。
 * ADR-002 が「Pages Functions で投稿API」と決めている以上、両立しない。
 * 全ページを静的配信 + APIだけ Functions にする方が無料枠にも優しい。
 * → 将来 SSR ページが必要になったら、アダプタを入れて API を
 *   `src/pages/api/` に移設する(その時点で ADR を起票する)。
 */
export default defineConfig({
  // 独自ドメイン取得後に SITE_URL を差し替える(canonical / og:url に使う)
  site: process.env.SITE_URL ?? 'https://shikakulog.pages.dev',
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  compressHTML: true,
  devToolbar: { enabled: false },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
});
