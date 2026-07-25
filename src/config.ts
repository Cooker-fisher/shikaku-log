/** サイト共通の定数。秘匿情報は置かない(ASP IDなどは Cloudflare の環境変数へ)。 */

export const SITE_NAME = 'シカクログ';
export const SITE_TAGLINE = '資格の公式統計と合格報告のデータベース';

/** 統計を公開する最小サンプル数。src/lib/metrics.ts の MIN_SAMPLE_SIZE と揃える。 */
export const MIN_SAMPLE_SIZE = 20;


/**
 * 問い合わせ先(Googleフォーム)。
 *
 * メールアドレスを直接載せない理由:
 *  - 公開ページに書くとスパムの標的になる
 *  - フォームなら「掲載内容の誤り」「削除依頼」などを項目で分けられ、
 *    削除依頼に必要な情報(投稿日時・資格名)を確実に集められる
 *
 * ⚠️ 公開前にオーナーが実在のフォームURLへ差し替えること。
 * 差し替え忘れると qa.mjs がプレースホルダを検出して公開をブロックする。
 */
export const CONTACT_FORM_URL = 'https://forms.gle/REPLACE_ME';

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

/**
 * 資格ごとの講座リンク(アフィリエイト)。
 *
 * **ASP審査に通るまで空のままにする。**空にしておけば CourseCta は何も描画しない。
 * 審査前に空の宣伝枠を置くのは読者に対して不誠実であり、中身のない領域が増えるだけ。
 *
 * ⚠️ 実URLに含まれるASPのIDは秘匿情報。ここに直書きせず、
 *    Cloudflare の環境変数から注入すること(qa.mjs がIDらしき文字列を検出して公開を止める)。
 */
export interface CourseLink {
  name: string;
  url: string;
  note?: string;
}

export const COURSE_LINKS: Record<string, CourseLink[]> = {
  // 'kikenbutsu-otsu4': [{ name: '...', url: '...' }],
};

export const AFFILIATE_DOMAINS: readonly string[] = [
  'px.a8.net',
  'af.moshimo.com',
  'ck.jp.ap.valuecommerce.com',
  'h.accesstrade.net',
  'amzn.to',
  'amazon.co.jp',
  'hb.afl.rakuten.co.jp',
];
