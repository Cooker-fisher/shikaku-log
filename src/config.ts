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
export const CONTACT_FORM_URL = 'https://forms.gle/p74hYkAqS8WMqvEv5';


/**
 * Google アナリティクス(GA4)の測定ID。
 * 空文字にすると計測タグを出力しない(ローカル開発・プレビューで汚さないため)。
 * 測定IDは秘匿情報ではない(HTMLに出る前提の公開値)。
 */
export const GA_MEASUREMENT_ID = 'G-Z7RFR77QVW';

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
 * **提携が承認されるまで空のままにする。**空にしておけば CourseCta は何も描画しない。
 * 審査前に空の宣伝枠を置くのは読者に対して不誠実であり、中身のない領域が増えるだけ。
 *
 * **リンクはここに直書きしてよい。**
 * 当初「ASPのIDは秘匿情報だから環境変数から注入する」と書いていたが、これは誤りだった。
 * アフィリエイトリンクは**公開HTMLに出力されなければ機能しない**(誰でもソースを見れば読める)。
 * 秘匿扱いにすると収益化した瞬間にデプロイが止まる。2026-07-26に修正。
 * 秘匿すべきはASPのログイン情報とAPIトークンであって、リンクの計測IDではない。
 *
 * ⚠️ 掲載は **EPCの高い順に2〜3件まで**([backlog B-015])。
 *    選択肢を増やすと高EPCのプログラムからクリックを奪い、総収益はむしろ下がる。
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
