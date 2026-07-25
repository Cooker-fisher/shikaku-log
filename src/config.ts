/** サイト共通の定数。秘匿情報は置かない(ASP IDなどは Cloudflare の環境変数へ)。 */

export const SITE_NAME = 'シカクログ';
export const SITE_TAGLINE = '資格の公式統計と合格報告のデータベース';

/** 統計を公開する最小サンプル数。src/lib/metrics.ts の MIN_SAMPLE_SIZE と揃える。 */
export const MIN_SAMPLE_SIZE = 20;


/**
 * 問い合わせ先。
 * ⚠️ 公開前にオーナーが実在のアドレスへ差し替えること。
 * 差し替え忘れると qa.mjs がプレースホルダを検出して公開をブロックする。
 */
export const CONTACT_EMAIL = 'REPLACE_ME@example.com';

export const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/about/', label: 'このサイトについて' },
];

export const FOOTER_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/', label: 'トップ' },
  { href: '/about/', label: 'このサイトについて' },
  { href: '/privacy/', label: 'プライバシーポリシー' },
  { href: '/contact/', label: 'お問い合わせ' },
];

/** アフィリエイトリンクとして扱うドメイン(qa.mjs と共有する概念)。 */
export const AFFILIATE_DOMAINS: readonly string[] = [
  'px.a8.net',
  'af.moshimo.com',
  'ck.jp.ap.valuecommerce.com',
  'h.accesstrade.net',
  'amzn.to',
  'amazon.co.jp',
  'hb.afl.rakuten.co.jp',
];
