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
  /*
   * 書き込み一覧は**全ページの上部**に出す。
   * 答える側はどの資格のページから来るか分からないので、
   * 資格ページの中だけに戻り先を置くと、結局その資格の読者にしか届かない。
   */
  { href: '/board/', label: '書き込み' },
  { href: '/about/', label: 'このサイトについて' },
];

export const FOOTER_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/', label: 'トップ' },
  { href: '/about/', label: 'このサイトについて' },
  { href: '/rules/', label: '投稿のルール' },
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

/**
 * SAT株式会社(A8)の商品リンク。2026-07-27 に提携。
 *
 * **ASPの管理画面で見た数字(EPC・確定率・確定件数・プログラムID)をここに書かない。**
 * `site/` は公開リポジトリである前提(掟4)。これらは広告主ごとの非公開実績であり、
 * 第三者に開示してよい性質のものではない。判断の根拠は
 * `research/affiliates/kyujin.md`(非公開側)に置く。
 * ここに書いてよいのは、公開HTMLに出ないと機能しない計測ID(a8mat)だけである。
 *
 * **飛び先は資格ごとの講座ページにしている。**A8の「商品リンク」機能で
 * `a8ejpredirect` に飛び先を入れると、a8mat は同じまま飛び先だけ変えられる。
 * 総合トップに落とすより、読んでいる資格の講座に直接着く方が読者の手数が少ない。
 *
 * 広告主の掲載条件(守らないと提携解除):
 *  - 飛び先は `https://www.sat-co.info` 内に限る
 *  - **サイト内の人物画像を使わない**(このサイトは画像を出していないので該当なし)
 *  - 広告と分かる表示が必須 → CourseCta のPR表記と BaseLayout の hasAffiliate で担保
 *
 * **丙種(kikenbutsu-hei)には置いていない。**SATの危険物講座は
 * 乙種第4類・乙種第1/2/3/5/6類・甲種を扱っており、丙種の講座が無い。
 * 扱っていない資格のページに講座リンクを置くと、読者は関係ない講座に飛ばされる。
 */
const SAT_A8MAT = '4B8ACS+6BFLV6+5TRO+BW0YB';
const satLink = (path: string) =>
  `https://px.a8.net/svt/ejp?a8mat=${SAT_A8MAT}&a8ejpredirect=${encodeURIComponent(`https://www.sat-co.info${path}`)}`;

/**
 * リンク文言に**必ず会社名を「◯◯株式会社」の形で入れる。**
 *
 * 当初「SATの危険物取扱者講座」と書いていたところ、初見レビューで
 * 「SATが何なのか分からないままクリックさせられる」と指摘された。
 * 読者はこの会社を知らない前提で書く。
 *
 * ただし**「大手」「合格者◯万人」のような信頼性の主張は書かない。**
 * 一次ソースで裏が取れないうえ、広告枠でそれを書けば掟3-9(誇大表現の禁止)に触れる。
 * 書いてよいのは「どこの会社の、何の講座で、どの区分に対応しているか」という事実だけ。
 */
const SAT_KIKENBUTSU: CourseLink = {
  name: 'SAT株式会社の危険物取扱者講座',
  url: satLink('/ec/kikenbutu'),
  note: '動画(eラーニング)とDVDから選べる通信講座。乙種第4類・甲種・乙種第1/2/3/5/6類に対応',
};

/**
 * オンスク.JP(株式会社オンラインスクール / A8)の商品リンク。2026-07-25 提携、2026-07-30 掲載。
 *
 * **SATが扱えない資格を埋めるために入れている。**SATは現場系国家資格(危険物・消防設備士・
 * ボイラー・衛生管理者)に特化しており、宅建・簿記3級・ITパスポート・FP・登録販売者を扱わない。
 * この6ページは提携から5日間、講座リンクが1本も無く構造的に¥0だった([backlog B-041])。
 *
 * **SATが既にあるページには足さない**([backlog B-015])。危険物乙4・第一種/第二種衛生管理者が該当する。
 * 選択肢を増やすと高EPCのプログラムからクリックを奪い、総収益はむしろ下がる。
 *
 * 広告主の掲載条件(守らないと提携解除・成果キャンセル):
 *  - 飛び先は `https://onsuku.jp` 内に限る
 *  - 広告と分かる表示が必須 → CourseCta のPR表記と BaseLayout の hasAffiliate で担保
 *  - **A8の管理画面にあるPR文(「業界最安値」等)を転載しない。**広告表示に適さない場合があると
 *    明記されており、掟3-9(誇大表現の禁止)にも触れる。ここに書く事実は onsuku.jp で直接確認したものだけ
 *  - 公開後、A8の「広告掲載URL管理」に掲載ページのURLを提出する(オーナー作業)
 *
 * **成果は有料プランの新規申込。無料体験・無料会員登録だけでは成果にならない**(否認条件)。
 * だからといって無料体験の存在を伏せない。読者にとっては入口がある方が事実として有用である。
 */
const ONSUKU_A8MAT = '4B88SZ+DOYXO2+408S+BW0YB';
const onsukuLink = (path: string) =>
  `https://px.a8.net/svt/ejp?a8mat=${ONSUKU_A8MAT}&a8ejpredirect=${encodeURIComponent(`https://onsuku.jp${path}`)}`;

/**
 * 注記は**サービス全体の事実**にとどめ、講座ごとの講義数・問題数は書かない。
 * 講座は改訂されるため(宅建講座は2026-06-04改訂)、資格ごとに数字を持つと確認できないまま古くなる。
 * 料金は https://onsuku.jp/plan_guidance で確認(2026-07-30)。
 */
const ONSUKU_NOTE =
  '月額1,078円(ライトプラン)または1,628円(スタンダードプラン)の定額制。初期費用・入会金なしで対象講座を受講できる。無料体験あり';

const onsuku = (subject: string, path: string): CourseLink => ({
  name: `オンスク.JP(株式会社オンラインスクール)の${subject}講座`,
  url: onsukuLink(path),
  note: ONSUKU_NOTE,
});

export const COURSE_LINKS: Record<string, CourseLink[]> = {
  takken: [onsuku('宅建(宅地建物取引士)', '/training/takkenshi')],
  'boki-3kyu': [onsuku('日商簿記3級', '/training/boki3')],
  'it-passport': [onsuku('ITパスポート', '/training/itpass')],
  'fp-2kyu': [onsuku('FP2級(ファイナンシャルプランナー)', '/training/fp2')],
  'fp-3kyu': [onsuku('FP3級(ファイナンシャルプランナー)', '/training/fp3')],
  'touroku-hanbaisha': [onsuku('登録販売者', '/training/touroku')],

  'kikenbutsu-otsu4': [SAT_KIKENBUTSU],
  'kikenbutsu-kou': [SAT_KIKENBUTSU],
  'kikenbutsu-otsu5': [SAT_KIKENBUTSU],
  'kikenbutsu-otsu6': [SAT_KIKENBUTSU],
  'shoubou-setsubi-otsu6': [
    {
      name: 'SAT株式会社の消防設備士講座',
      url: satLink('/ec/syoubou'),
      note: '動画(eラーニング)とDVDから選べる通信講座。乙種第6類・乙種第4類・甲種第4類に対応',
    },
  ],
  'boiler-2kyu': [
    {
      name: 'SAT株式会社の二級ボイラー技士講座',
      url: satLink('/ec/boiler'),
      note: '動画(eラーニング)とDVDから選べる通信講座',
    },
  ],
  'eisei-kanri-1': [
    {
      name: 'SAT株式会社の衛生管理者講座',
      url: satLink('/ec/eiseikanrisya'),
      note: '動画(eラーニング)とDVDから選べる通信講座。第一種・第二種に対応',
    },
  ],
  'eisei-kanri-2': [
    {
      name: 'SAT株式会社の衛生管理者講座',
      url: satLink('/ec/eiseikanrisya'),
      note: '動画(eラーニング)とDVDから選べる通信講座。第一種・第二種に対応',
    },
  ],
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
