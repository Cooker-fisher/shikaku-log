/**
 * 資格をまたぐ比較・解説ページの一覧。
 *
 * **なぜ一覧を持つか**: 比較ページは特定の資格に属さないため、
 * 資格ページ側から自動でリンクする手立てが無く、放っておくと孤立する
 * (実際 `npm run qa` が最初の1本を孤立ページとして検出した)。
 * ここに登録しておけば、**該当する資格ページとサイトマップの両方から自動で参照される**。
 *
 * 新しい比較ページを作ったら必ずここに足すこと。足し忘れは qa が孤立ページとして落とす。
 */
export interface Guide {
  path: string;
  title: string;
  /** このページが扱う資格の slug。ここに含まれる資格ページからリンクされる */
  covers: string[];
  /** 資格ページ側に出す一文。何が分かるページかを書く */
  blurb: string;
}

export const guides: Guide[] = [
  {
    path: '/hikaku/kikenbutsu/',
    title: '危険物取扱者はどの類が難しいか',
    covers: [
      'kikenbutsu-kou',
      'kikenbutsu-otsu4',
      'kikenbutsu-otsu5',
      'kikenbutsu-otsu6',
      'kikenbutsu-hei',
    ],
    blurb: '甲種・乙種1〜6類・丙種の合格率を並べています。乙種第4類だけが31.9%と低い理由も扱っています。',
  },
];

/** ある資格ページから参照すべき比較ページを返す */
export function guidesFor(slug: string): Guide[] {
  return guides.filter((g) => g.covers.includes(slug));
}
