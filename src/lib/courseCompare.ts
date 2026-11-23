/**
 * 通信講座の比較ページ(/hikaku/kouza/[key]/)のデータ。
 *
 * **載せるのは、運営者が提携していて、かつその資格の講座を実際に売っている会社だけ。**
 * 提携していない講座を「比較」に混ぜると、広告リンクのある会社だけが有利に見える表になる。
 * 逆に、全社を並べたように見せて提携先しか載せないのも不誠実なので、
 * ページ側で「提携している2社だけ」と明記している。
 *
 * **書いてよいのは、各社の公式ページで確認した事実だけ。**
 * 料金・学び方・対応区分・保証の有無まで。「おすすめ」「安い」「わかりやすい」は書かない。
 * 講義数・問題数は講座の改訂で変わるので持たない(config.ts の ONSUKU_NOTE と同じ理由)。
 *
 * 料金を直すときは `retrievedAt` も必ず直すこと。古い料金を広告の横に出すのは不当表示になる。
 */
import { satLink, onsukuLink } from '../config';

export interface PriceRow {
  label: string;
  /** 税込・円 */
  yen: number;
}

export interface CompareCourse {
  company: string;
  courseName: string;
  /** 広告リンク */
  url: string;
  /** 料金の形(買い切り / 月額など) */
  pricingModel: string;
  prices: PriceRow[];
  priceNote?: string;
  format: string;
  covers: string;
  /** 保証・体験など。公式ページの記載どおりに書く */
  terms: string;
  sources: Array<{ label: string; url: string }>;
}

export interface CourseCompare {
  key: string;
  /** 資格の呼び名(見出し用) */
  subject: string;
  /** このページからリンクする資格ページ */
  entitySlugs: string[];
  /** 月額制と比べるときの基準にする買い切り価格 */
  baseline: { label: string; yen: number };
  courses: CompareCourse[];
  retrievedAt: string;
}

const RETRIEVED = '2026-11-23';

/** オンスク.JP の料金は全講座共通(https://onsuku.jp/plan_guidance) */
export const ONSUKU_MONTHLY = { light: 1078, standard: 1628 };

const onsukuCourse = (subject: string, path: string, covers: string): CompareCourse => ({
  company: 'オンスク.JP(株式会社オンラインスクール)',
  courseName: `${subject}講座`,
  url: onsukuLink(path),
  pricingModel: '定額制。対象講座すべてを受講できる',
  prices: [
    { label: 'ライトプラン(月額)', yen: ONSUKU_MONTHLY.light },
    { label: 'スタンダードプラン(月額)', yen: ONSUKU_MONTHLY.standard },
    { label: 'スタンダード 3ヵ月パック', yen: 4884 },
    { label: 'スタンダード 6ヵ月パック', yen: 9471 },
    { label: 'スタンダード 12ヵ月パック', yen: 18557 },
  ],
  priceNote: '月額プランは毎月自動更新。プランによって使える機能が異なる。初期費用・入会金は0円',
  format: 'オンライン(講義動画・練習問題・ダウンロード教材)',
  covers,
  terms: '無料体験あり',
  sources: [
    { label: `${subject}講座(オンスク.JP)`, url: `https://onsuku.jp${path}` },
    { label: '料金プラン(オンスク.JP)', url: 'https://onsuku.jp/plan_guidance' },
  ],
});

const SAT_TERMS = '質問サポート、30日間返金保証(条件あり)、不合格時のサポート期間延長';

export const courseCompares: CourseCompare[] = [
  {
    key: 'kikenbutsu-otsu4',
    subject: '危険物取扱者 乙種第4類',
    entitySlugs: ['kikenbutsu-otsu4'],
    baseline: { label: 'SAT株式会社のE講座(乙種)', yen: 8580 },
    retrievedAt: RETRIEVED,
    courses: [
      {
        company: 'SAT株式会社',
        courseName: '危険物取扱者講座',
        url: satLink('/ec/kikenbutu'),
        pricingModel: '買い切り。区分ごとに購入する',
        prices: [
          { label: 'E講座(eラーニング)・乙種', yen: 8580 },
          { label: 'DVD講座・乙種', yen: 10780 },
          { label: 'E+DVD講座・乙種', yen: 21780 },
        ],
        priceNote: '乙種は類ごとの価格。甲種は別価格(E講座 28,380円)',
        format: 'eラーニング(スマホ・PC)、DVD、その両方から選ぶ',
        covers: '乙種第4類のほか、甲種・乙種第1/2/3/5/6類',
        terms: SAT_TERMS,
        sources: [{ label: '危険物取扱者講座(SAT株式会社)', url: 'https://www.sat-co.info/ec/kikenbutu' }],
      },
      onsukuCourse('危険物乙4', '/training/otu4', '乙種第4類'),
    ],
  },
  {
    key: 'eisei-kanri',
    subject: '衛生管理者',
    entitySlugs: ['eisei-kanri-1', 'eisei-kanri-2'],
    baseline: { label: 'SAT株式会社のE講座(第二種)', yen: 17380 },
    retrievedAt: RETRIEVED,
    courses: [
      {
        company: 'SAT株式会社',
        courseName: '衛生管理者講座',
        url: satLink('/ec/eiseikanrisya'),
        pricingModel: '買い切り。第一種・第二種のどちらかを購入する',
        prices: [
          { label: 'E講座(eラーニング)・第二種', yen: 17380 },
          { label: 'E講座(eラーニング)・第一種', yen: 21780 },
          { label: 'DVD講座・第二種', yen: 19580 },
          { label: 'DVD講座・第一種', yen: 23980 },
          { label: 'E+DVD講座・第二種', yen: 21780 },
          { label: 'E+DVD講座・第一種', yen: 27280 },
        ],
        format: 'eラーニング(スマホ・PC)、DVD、その両方から選ぶ',
        covers: '第一種・第二種',
        terms: SAT_TERMS,
        sources: [{ label: '衛生管理者講座(SAT株式会社)', url: 'https://www.sat-co.info/ec/eiseikanrisya' }],
      },
      onsukuCourse('衛生管理者', '/training/eisei2', '第一種・第二種の両方'),
    ],
  },
];

/** 月額を何か月払うと買い切り価格を超えるか(超える最初の月) */
export function monthsToExceed(monthlyYen: number, baselineYen: number): number {
  return Math.floor(baselineYen / monthlyYen) + 1;
}
