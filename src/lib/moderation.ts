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

const ALL_RULES: Rule[] = [...LINK_RULES, ...SOLICITATION_RULES, ...ABUSE_RULES, ...PII_RULES];

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
