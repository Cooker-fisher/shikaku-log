/**
 * 投稿の入力検証(汎用)。
 *
 * スキーマ記述 (FieldSpec) を1つ書けば
 *   - フォーム生成(将来)
 *   - Pages Functions 側のサーバ検証
 * の両方をそれを駆動できるようにしてある。D1 の report_schemas.schema に
 * 同じ JSON を入れて型ごとに切り替える。
 *
 * 方針: 「知らないフィールドは黙って捨てる」「範囲外はエラーにする」。
 * 通したものだけが payload になるので、DBに未知のキーは入らない。
 */

export type FieldSpec =
  | {
      type: 'int' | 'number';
      minInclusive?: number;
      maxInclusive?: number;
      minExclusive?: number;
      required?: boolean;
      label?: string;
    }
  | {
      type: 'string';
      minLength?: number;
      maxLength: number;
      pattern?: string;
      moderate?: boolean;
      required?: boolean;
      label?: string;
    }
  | {
      type: 'enum';
      values: string[];
      required?: boolean;
      label?: string;
    }
  | {
      type: 'string[]';
      maxItems: number;
      maxLength: number;
      moderate?: boolean;
      required?: boolean;
      label?: string;
    }
  | {
      type: 'bool';
      required?: boolean;
      label?: string;
    };

export interface ReportSchema {
  fields: Record<string, FieldSpec>;
}

export interface FieldError {
  field: string;
  code:
    | 'required'
    | 'type'
    | 'range'
    | 'too_long'
    | 'too_many'
    | 'not_allowed'
    | 'pattern'
    | 'blocked';
  message: string;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: FieldError[] };

/** 1号店(資格)の投稿スキーマ。migrations/0001_init.sql のシードと同じ内容。 */
export const CERTIFICATION_REPORT_SCHEMA: ReportSchema = {
  fields: {
    study_hours: {
      type: 'int',
      minExclusive: 0,
      maxInclusive: 10000,
      required: true,
      label: '総勉強時間',
    },
    attempts: {
      type: 'int',
      minInclusive: 1,
      maxInclusive: 20,
      required: true,
      label: '受験回数',
    },
    passed_year: {
      type: 'int',
      minInclusive: 2000,
      maxInclusive: 2100,
      required: true,
      label: '合格年',
    },
    study_months: {
      type: 'int',
      minInclusive: 1,
      maxInclusive: 240,
      required: false,
      label: '学習期間(月)',
    },
    method: {
      type: 'enum',
      values: ['independent', 'online', 'school', 'company'],
      required: false,
      label: '学習方法',
    },
    materials: {
      type: 'string[]',
      maxItems: 5,
      maxLength: 60,
      moderate: true,
      required: false,
      label: '使用教材',
    },
    comment: {
      type: 'string',
      maxLength: 400,
      moderate: true,
      required: false,
      label: 'ひとこと',
    },
  },
};

/**
 * ゼロ幅・双方向制御など「見えない文字」のコードポイント。
 * NGワードの間に不可視文字を挟んでフィルタを抜ける古典的な手口を潰す。
 * 正規表現に制御文字を直書きしないため、集合で持つ。
 */
const INVISIBLE_CODE_POINTS = new Set<number>([
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b,
  0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069,
  0xfeff, 0xfff9, 0xfffa, 0xfffb,
]);

const CP_TAB = 0x09;
const CP_LF = 0x0a;
const CP_CR = 0x0d;

/** 制御文字・不可視文字を除去する(タブ・改行は残す) */
function stripInvisible(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x20 && cp !== CP_TAB && cp !== CP_LF && cp !== CP_CR) continue; // C0制御
    if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue; // DEL / C1制御
    if (INVISIBLE_CODE_POINTS.has(cp)) continue;
    out += ch;
  }
  return out;
}

/** 制御文字・ゼロ幅文字を落とし、連続空白を畳む */
export function sanitizeText(input: string): string {
  return stripInvisible(input.normalize('NFKC'))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const trimmed = raw.normalize('NFKC').trim().replace(/,/g, '');
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @param moderator NGワード検査。true を返したら 'blocked' エラーにする。
 */
export function validateReport(
  raw: unknown,
  schema: ReportSchema,
  moderator?: (text: string) => { blocked: boolean; reason?: string },
): ValidationResult {
  const errors: FieldError[] = [];
  const value: Record<string, unknown> = {};

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: '_', code: 'type', message: '形式が不正' }] };
  }
  const input = raw as Record<string, unknown>;

  const moderate = (field: string, text: string, spec: FieldSpec): boolean => {
    if (!('moderate' in spec) || !spec.moderate || !moderator) return false;
    const verdict = moderator(text);
    if (verdict.blocked) {
      errors.push({
        field,
        code: 'blocked',
        message: verdict.reason ?? '投稿できない内容が含まれている',
      });
      return true;
    }
    return false;
  };

  for (const [field, spec] of Object.entries(schema.fields)) {
    const rawValue = input[field];
    const isEmpty =
      rawValue === undefined ||
      rawValue === null ||
      (typeof rawValue === 'string' && rawValue.trim() === '') ||
      (Array.isArray(rawValue) && rawValue.length === 0);

    if (isEmpty) {
      if (spec.required) {
        errors.push({
          field,
          code: 'required',
          message: `${spec.label ?? field}は必須`,
        });
      }
      continue;
    }

    switch (spec.type) {
      case 'int':
      case 'number': {
        const n = toNumber(rawValue);
        if (n === null) {
          errors.push({ field, code: 'type', message: `${spec.label ?? field}は数値で入力` });
          break;
        }
        if (spec.type === 'int' && !Number.isInteger(n)) {
          errors.push({ field, code: 'type', message: `${spec.label ?? field}は整数で入力` });
          break;
        }
        if (spec.minExclusive !== undefined && !(n > spec.minExclusive)) {
          errors.push({ field, code: 'range', message: `${spec.label ?? field}が範囲外` });
          break;
        }
        if (spec.minInclusive !== undefined && n < spec.minInclusive) {
          errors.push({ field, code: 'range', message: `${spec.label ?? field}が範囲外` });
          break;
        }
        if (spec.maxInclusive !== undefined && n > spec.maxInclusive) {
          errors.push({ field, code: 'range', message: `${spec.label ?? field}が範囲外` });
          break;
        }
        value[field] = n;
        break;
      }

      case 'string': {
        if (typeof rawValue !== 'string') {
          errors.push({ field, code: 'type', message: `${spec.label ?? field}の形式が不正` });
          break;
        }
        const text = sanitizeText(rawValue);
        if (spec.minLength !== undefined && text.length < spec.minLength) {
          errors.push({ field, code: 'range', message: `${spec.label ?? field}が短すぎる` });
          break;
        }
        if (text.length > spec.maxLength) {
          errors.push({
            field,
            code: 'too_long',
            message: `${spec.label ?? field}は${spec.maxLength}文字まで`,
          });
          break;
        }
        if (spec.pattern && !new RegExp(spec.pattern, 'u').test(text)) {
          errors.push({ field, code: 'pattern', message: `${spec.label ?? field}の形式が不正` });
          break;
        }
        if (moderate(field, text, spec)) break;
        value[field] = text;
        break;
      }

      case 'enum': {
        if (typeof rawValue !== 'string' || !spec.values.includes(rawValue)) {
          errors.push({
            field,
            code: 'not_allowed',
            message: `${spec.label ?? field}の値が不正`,
          });
          break;
        }
        value[field] = rawValue;
        break;
      }

      case 'string[]': {
        if (!Array.isArray(rawValue)) {
          errors.push({ field, code: 'type', message: `${spec.label ?? field}の形式が不正` });
          break;
        }
        if (rawValue.length > spec.maxItems) {
          errors.push({
            field,
            code: 'too_many',
            message: `${spec.label ?? field}は${spec.maxItems}件まで`,
          });
          break;
        }
        const items: string[] = [];
        let failed = false;
        for (const item of rawValue) {
          if (typeof item !== 'string') {
            errors.push({ field, code: 'type', message: `${spec.label ?? field}の形式が不正` });
            failed = true;
            break;
          }
          const text = sanitizeText(item);
          if (text === '') continue;
          if (text.length > spec.maxLength) {
            errors.push({
              field,
              code: 'too_long',
              message: `${spec.label ?? field}は各${spec.maxLength}文字まで`,
            });
            failed = true;
            break;
          }
          if (moderate(field, text, spec)) {
            failed = true;
            break;
          }
          if (!items.includes(text)) items.push(text);
        }
        if (!failed && items.length > 0) value[field] = items;
        break;
      }

      case 'bool': {
        value[field] = rawValue === true || rawValue === 'true' || rawValue === 1;
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}
