/**
 * 投稿本文のNGワード / スパム判定。
 *
 * 方針:
 *  - 「資格の話として当然出る言葉」を巻き込まない。例えば「投資」「副業」は
 *    FP・簿記・宅建の投稿で普通に出るので単語だけでは弾かない。
 *  - 弾くのは ①外部誘導(URL・連絡先) ②勧誘/情報商材 ③誹謗中傷・脅迫。
 *  - 判定は「拒否」ではなく「保留(pending のまま人手審査)」に倒せるよう、
 *    reason を返して呼び出し側が使い分けられるようにしてある。
 *
 * 検査対象の文字列は validation.sanitizeText() 通過後(不可視文字は除去済み)を前提とする。
 */

export interface ModerationVerdict {
  blocked: boolean;
  reason?: string;
  /** どのルールに当たったか(review_note に残す。個人情報は入れない) */
  rule?: string;
  /**
   * 自由文の投稿をどう扱うか。
   *   ok     … そのまま公開してよい
   *   hold   … 公開せず pending にする(灰色。人が見るまで出さない)
   *   reject … 保存もしない
   *
   * **なぜ3段階が要るか**: 自由投稿を全件人手で見る設計は、投稿が増えた瞬間に破綻する。
   * かといって全件自動公開にすると、灰色のものがそのまま出る。
   * 「明確に黒だけ落とし、灰色は止め、白は出す」の3つに分けるのが唯一続く形である。
   */
  severity?: 'ok' | 'hold' | 'reject';
}

interface Rule {
  name: string;
  pattern: RegExp;
  reason: string;
}

/** 外部誘導 */
const LINK_RULES: Rule[] = [
  {
    name: 'url',
    pattern: /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|jp|org|io|co|me|xyz|info|shop|link|site)\b)/i,
    reason: 'URLは投稿できない',
  },
  {
    name: 'email',
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    reason: 'メールアドレスは投稿できない',
  },
  {
    name: 'phone',
    pattern: /(0\d{1,4}-?\d{1,4}-?\d{3,4})/,
    reason: '電話番号は投稿できない',
  },
  {
    name: 'messenger_id',
    pattern: /(LINE\s*(ID|@)|カカオ|テレグラム|telegram|@[A-Za-z0-9_]{4,}\s*(まで|へ|に)?(連絡|DM|dm))/i,
    reason: '連絡先の記載は投稿できない',
  },
];

/** 勧誘・情報商材・アフィリエイト誘導 */
const SOLICITATION_RULES: Rule[] = [
  {
    name: 'get_rich',
    pattern: /(誰でも稼|簡単に稼|月収\s*\d+\s*万|不労所得|情報商材|コピペで|ノーリスク|絶対儲)/,
    reason: '勧誘とみなされる表現が含まれている',
  },
  {
    name: 'referral',
    pattern: /(紹介コード|招待コード|referral|アフィリエイトリンク|登録はこちら|今すぐ登録)/i,
    reason: '勧誘とみなされる表現が含まれている',
  },
  {
    name: 'adult_or_gamble',
    pattern: /(出会い系|アダルト|オンラインカジノ|パチンコ必勝|裏バイト|闇バイト)/,
    reason: '投稿できない内容が含まれている',
  },
];

/** 誹謗中傷・脅迫 */
const ABUSE_RULES: Rule[] = [
  {
    name: 'threat',
    pattern: /(死ね|殺す|殺害|自殺しろ|消えろ|晒してやる|潰してやる)/,
    reason: '他者を傷つける表現が含まれている',
  },
  {
    name: 'slur',
    pattern: /(気持ち悪い奴|クズ野郎|カス人間|池沼|きちがい|キチガイ)/,
    reason: '他者を傷つける表現が含まれている',
  },
];

/** 個人特定情報の書き込み(投稿者本人・第三者を問わず) */
const PII_RULES: Rule[] = [
  {
    name: 'my_number',
    pattern: /(マイナンバー|個人番号)\s*[::]?\s*\d{4}/,
    reason: '個人情報は投稿できない',
  },
  {
    name: 'card',
    pattern: /\b(?:\d{4}[ -]?){3}\d{4}\b/,
    reason: '個人情報は投稿できない',
  },
];

/**
 * 試験問題の転載(著作権侵害)。
 *
 * 資格試験の問題文は実施団体に著作権がある。「思い出し」であっても、
 * 選択肢まで揃った再現は複製とみなされうる。**うちが訴えられる側になる。**
 * 5ch の資格板では試験直後にこの種の書き込みが集中するため、必ず止める。
 *
 * 灰色なので reject ではなく hold(人が見るまで出さない)に倒す。
 * 「どの分野が出た」「法令が難しかった」のような**感想は通す**。
 */
const EXAM_LEAK_RULES: Rule[] = [
  {
    name: 'choices',
    // ①②③④ / 1. 2. 3. 4. のような選択肢が3つ以上並ぶ
    pattern: /([①-⑳]\s*\S+.*){3,}|((^|\s)[1-5][.．)）]\s*\S+.*){3,}/m,
    reason: '試験問題の再現とみなされる形式が含まれている',
  },
  {
    name: 'answer_key',
    pattern: /(正解は|答えは|解答は)\s*[①-⑳1-5]|問\s*\d+\s*[のは]\s*(答|正解)/,
    reason: '試験問題の再現とみなされる形式が含まれている',
  },
];

const ALL_RULES: Rule[] = [...LINK_RULES, ...SOLICITATION_RULES, ...ABUSE_RULES, ...PII_RULES];

/**
 * 明確に黒(保存もしない)。灰色は hold に回す。
 *
 * 外部誘導(url / email / phone / messenger_id)を hold ではなく reject にしているのは、
 * **投稿者にその場で理由を返せるから**である。hold にすると投稿者は
 * 「出したつもりで永久に出ない」状態になり、URLを消して出し直す機会も無い。
 *
 * 逆に試験問題の再現は hold に倒す。誤検知したとき(勉強する分野を番号付きで
 * 並べただけ、など)に消してしまうと、善意の投稿を失う。
 */
const REJECT_RULE_NAMES = new Set([
  'url',
  'email',
  'phone',
  'messenger_id',
  'threat',
  'slur',
  'adult_or_gamble',
  'get_rich',
  'referral',
  'card',
  'my_number',
  'spam_shape',
]);

/** 同じ文字の異常な繰り返し(荒らし) */
function isSpammyShape(text: string): boolean {
  if (/(.)\1{9,}/u.test(text)) return true;
  // 記号だけ、または記号比率が高すぎる
  const symbols = text.replace(/[\p{L}\p{N}\s]/gu, '').length;
  return text.length >= 20 && symbols / text.length > 0.5;
}

/** 全角化・記号除去で回避を潰した比較用の文字列 */
function foldForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.\-_*+~^|/\\]/g, '');
}

export function moderateText(text: string): ModerationVerdict {
  if (text.trim() === '') return { blocked: false };

  const folded = foldForMatch(text);
  for (const rule of ALL_RULES) {
    if (rule.pattern.test(text) || rule.pattern.test(folded)) {
      return { blocked: true, reason: rule.reason, rule: rule.name };
    }
  }
  if (isSpammyShape(text)) {
    return { blocked: true, reason: '内容を確認できない文字列', rule: 'spam_shape' };
  }
  return { blocked: false };
}

/** validateReport に渡す用 */
export const moderator = (text: string): { blocked: boolean; reason?: string } =>
  moderateText(text);

/**
 * 自由文の投稿(thread / reply)を、公開・保留・拒否のどれにするか決める。
 *
 * **LLMを一切通さない。**投稿1件ごとにモデルを呼ぶ設計は、
 * 投稿が増えるほど費用が増え、増えてほしいものを増やせなくなる。
 * ここで判定できないものは hold にして、人が見るまで公開しない。
 */
export function classifyPost(text: string): ModerationVerdict {
  const body = text.trim();

  if (body.length < 10) {
    return { blocked: true, severity: 'reject', rule: 'too_short', reason: '10文字以上で書いてください' };
  }
  if ([...body].length > 400) {
    return { blocked: true, severity: 'reject', rule: 'too_long', reason: '400文字までで書いてください' };
  }

  const base = moderateText(body);
  if (base.blocked) {
    const severity = REJECT_RULE_NAMES.has(base.rule ?? '') ? 'reject' : 'hold';
    return { ...base, severity };
  }

  const folded = foldForMatch(body);
  for (const rule of EXAM_LEAK_RULES) {
    if (rule.pattern.test(body) || rule.pattern.test(folded)) {
      return { blocked: true, severity: 'hold', reason: rule.reason, rule: rule.name };
    }
  }

  return { blocked: false, severity: 'ok' };
}
