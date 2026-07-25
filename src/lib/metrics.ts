/**
 * 投稿データの集計ロジック(汎用)。
 *
 * ============================ 絶対規則 ============================
 * サンプル数 n < MIN_SAMPLE_SIZE のとき、中央値・パーセンタイル・
 * ランキングを **一切返さない**。代わりに { status:'collecting', sampleSize:n } を返す。
 *
 * 理由: 少数サンプルの中央値は投稿が1件増えるたびに跳ねる。
 * 「先週300時間だった中央値が今週450時間」を見たユーザーはこのサイトを
 * 二度と数字の根拠に使わない。データサイトとしての信用が壊れる。
 *
 * この判定を **テンプレート側に委ねない**。テンプレートは「表示するか」を
 * 選べるだけで、「数値を得るか」を選べない構造にしてある。
 * 生の median()/quantile() は export しない。
 * ================================================================
 *
 * 1号店(資格)専用にしない。設定オブジェクトで駆動し、
 * 2号店(住まい・お金の実例DB)でもそのまま使う。
 */

/** 統計値を出してよい最小サンプル数。ここを下げる変更は ADR 起票が必要。 */
export const MIN_SAMPLE_SIZE = 20;

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** 除外の内訳。「何件を捨てたか」を必ず開示する(掟: 統計を装わない) */
export interface Exclusions {
  /** 除外合計 */
  total: number;
  /** 数値として読めなかった(null / 文字列 / NaN など) */
  invalid: number;
  /** 範囲外(勉強時間0以下、10,000時間超 など) */
  outOfRange: number;
}

/** n が閾値未満のときの唯一の返り値。統計値は含まれない。 */
export interface CollectingResult {
  status: 'collecting';
  /** 有効サンプル数(除外後) */
  sampleSize: number;
  minSampleSize: number;
  /** あと何件で公開できるか */
  remaining: number;
  excluded: Exclusions;
}

export interface HistogramBin {
  /** 下端(この値を含む) */
  from: number;
  /** 上端(この値を含まない)。最終ビンは null = 上限なし */
  to: number | null;
  count: number;
  /** 有効サンプルに対する割合 0-1 */
  ratio: number;
}

export interface NumericSummary {
  status: 'ready';
  /** 有効サンプル数。表示側は必ずこれを併記する(掟 3-3) */
  sampleSize: number;
  /** 除外前の件数 */
  rawCount: number;
  excluded: Exclusions;
  min: number;
  max: number;
  p10: number;
  q1: number;
  median: number;
  q3: number;
  p90: number;
  /** 参考値。外れ値に引きずられるので前面に出さない */
  mean: number;
  histogram: HistogramBin[];
}

export type NumericResult = CollectingResult | NumericSummary;

export interface CategoryRankItem {
  /** 正規化キー(重複統合用) */
  key: string;
  /** 表示名(最頻の原文表記) */
  label: string;
  count: number;
  /** 有効サンプル数に対する使用率 0-1 */
  share: number;
}

export interface CategoryRanking {
  status: 'ready';
  /** 有効な回答をした投稿の件数 */
  sampleSize: number;
  rawCount: number;
  /** 延べ選択数 */
  totalMentions: number;
  excluded: Exclusions;
  items: CategoryRankItem[];
}

export type CategoryResult = CollectingResult | CategoryRanking;

export interface PercentileRank {
  status: 'ready';
  sampleSize: number;
  /** 自分より小さい値の割合(0-100)。「短い方から◯%」 */
  percentile: number;
}

export type PercentileResult = CollectingResult | PercentileRank;

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

export interface NumericFieldOptions {
  /** この値**より大きい**もののみ有効(勉強時間なら 0) */
  minExclusive?: number;
  /** この値**以下**のもののみ有効(勉強時間なら 10000) */
  maxInclusive?: number;
  /** ヒストグラムの境界。最後の要素より上は「◯以上」ビンになる */
  binEdges?: number[];
  /** 個別に閾値を上書きしたい場合のみ。通常は触らない */
  minSampleSize?: number;
}

export interface CategoryFieldOptions {
  /** 1投稿あたりで数える最大件数(乱打対策) */
  maxItemsPerReport?: number;
  /** 上位いくつまで返すか */
  topN?: number;
  /** これ未満の件数の項目は「その他」に丸めず単に落とす(ロングテールのノイズ除去) */
  minCount?: number;
  minSampleSize?: number;
}

export interface MetricConfig {
  numeric?: Record<string, NumericFieldOptions>;
  category?: Record<string, CategoryFieldOptions>;
}

/** 1号店(資格)の設定 */
export const CERTIFICATION_METRIC_CONFIG: MetricConfig = {
  numeric: {
    study_hours: {
      // 0時間は「入力ミス or 冷やかし」、10,000時間超(=1日3時間で9年)は非現実的
      minExclusive: 0,
      maxInclusive: 10000,
      binEdges: [0, 50, 100, 200, 300, 500, 800, 1200, 2000],
    },
    attempts: {
      minExclusive: 0,
      maxInclusive: 20,
      binEdges: [1, 2, 3, 4, 5],
    },
    study_months: {
      minExclusive: 0,
      maxInclusive: 240,
      binEdges: [0, 1, 3, 6, 12, 24],
    },
  },
  category: {
    materials: { maxItemsPerReport: 5, topN: 10, minCount: 2 },
    method: { maxItemsPerReport: 1, topN: 10 },
  },
};

// ---------------------------------------------------------------------------
// 内部ヘルパー(export しない = 閾値を迂回できない)
// ---------------------------------------------------------------------------

const DEFAULT_BIN_EDGES = [0, 50, 100, 200, 300, 500, 800, 1200, 2000];

/** R-7 / Excel PERCENTILE.INC と同じ線形補間 */
function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0] as number;
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  if (lo === hi) return a;
  return a + (b - a) * (pos - lo);
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function emptyExclusions(): Exclusions {
  return { total: 0, invalid: 0, outOfRange: 0 };
}

function collecting(
  sampleSize: number,
  excluded: Exclusions,
  minSampleSize: number,
): CollectingResult {
  return {
    status: 'collecting',
    sampleSize,
    minSampleSize,
    remaining: Math.max(0, minSampleSize - sampleSize),
    excluded,
  };
}

/** 数値として読み、範囲外を弾く。除外理由を数える。 */
function collectNumbers(
  values: readonly unknown[],
  options: NumericFieldOptions,
): { valid: number[]; excluded: Exclusions } {
  const excluded = emptyExclusions();
  const valid: number[] = [];
  const lo = options.minExclusive;
  const hi = options.maxInclusive;

  for (const raw of values) {
    let n: number;
    if (typeof raw === 'number') {
      n = raw;
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      n = Number(raw);
    } else {
      excluded.invalid++;
      continue;
    }
    if (!Number.isFinite(n)) {
      excluded.invalid++;
      continue;
    }
    if (lo !== undefined && !(n > lo)) {
      excluded.outOfRange++;
      continue;
    }
    if (hi !== undefined && !(n <= hi)) {
      excluded.outOfRange++;
      continue;
    }
    valid.push(n);
  }
  excluded.total = excluded.invalid + excluded.outOfRange;
  return { valid, excluded };
}

function buildHistogram(sorted: number[], edges: number[]): HistogramBin[] {
  const n = sorted.length;
  const bins: HistogramBin[] = [];
  for (let i = 0; i < edges.length; i++) {
    const from = edges[i] as number;
    const to = i + 1 < edges.length ? (edges[i + 1] as number) : null;
    const count = sorted.filter((v) => v >= from && (to === null || v < to)).length;
    bins.push({ from, to, count, ratio: n === 0 ? 0 : round(count / n, 4) });
  }
  return bins;
}

/** 全角/半角・記号ゆれを吸収して統合キーを作る */
function normalizeLabel(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[　\s]+/g, ' ')
    .trim()
    .replace(/[、。,.!!??・･\-‐―ー~〜"'"'`]+$/u, '')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 数値項目の要約。n < MIN_SAMPLE_SIZE なら統計値は返らない。
 */
export function summarizeNumeric(
  values: readonly unknown[],
  options: NumericFieldOptions = {},
): NumericResult {
  const minSampleSize = options.minSampleSize ?? MIN_SAMPLE_SIZE;
  const { valid, excluded } = collectNumbers(values, options);
  const n = valid.length;

  // ---- 閾値ゲート:ここより下に統計値の計算は一切ない ----
  if (n < minSampleSize) {
    return collecting(n, excluded, minSampleSize);
  }

  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);

  return {
    status: 'ready',
    sampleSize: n,
    rawCount: values.length,
    excluded,
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    p10: round(quantileSorted(sorted, 0.1)),
    q1: round(quantileSorted(sorted, 0.25)),
    median: round(quantileSorted(sorted, 0.5)),
    q3: round(quantileSorted(sorted, 0.75)),
    p90: round(quantileSorted(sorted, 0.9)),
    mean: round(sum / n),
    histogram: buildHistogram(sorted, options.binEdges ?? DEFAULT_BIN_EDGES),
  };
}

/**
 * カテゴリ項目(使用教材など)のランキング。
 * 引数は「投稿ごとの配列」。1投稿 = 1要素。
 * n < MIN_SAMPLE_SIZE なら順位を返さない(ランキングも閾値の対象)。
 */
export function rankCategories(
  perReport: readonly unknown[],
  options: CategoryFieldOptions = {},
): CategoryResult {
  const minSampleSize = options.minSampleSize ?? MIN_SAMPLE_SIZE;
  const maxItems = options.maxItemsPerReport ?? 5;
  const excluded = emptyExclusions();

  /** key -> { count, labels } */
  const counts = new Map<string, { count: number; labels: Map<string, number> }>();
  let contributingReports = 0;
  let totalMentions = 0;

  for (const entry of perReport) {
    const list: unknown[] = Array.isArray(entry) ? entry : entry == null ? [] : [entry];
    if (list.length === 0) {
      excluded.invalid++;
      continue;
    }
    const seenInThisReport = new Set<string>();
    let used = 0;
    for (const item of list) {
      if (used >= maxItems) break;
      if (typeof item !== 'string') {
        excluded.invalid++;
        continue;
      }
      const key = normalizeLabel(item);
      if (key === '' || key.length > 80) {
        excluded.outOfRange++;
        continue;
      }
      // 同一投稿内の重複はカウントしない
      if (seenInThisReport.has(key)) continue;
      seenInThisReport.add(key);
      used++;
      totalMentions++;
      const bucket = counts.get(key) ?? { count: 0, labels: new Map<string, number>() };
      bucket.count++;
      const display = item.normalize('NFKC').trim();
      bucket.labels.set(display, (bucket.labels.get(display) ?? 0) + 1);
      counts.set(key, bucket);
    }
    if (seenInThisReport.size > 0) contributingReports++;
    else excluded.invalid++;
  }
  excluded.total = excluded.invalid + excluded.outOfRange;

  // ---- 閾値ゲート ----
  if (contributingReports < minSampleSize) {
    return collecting(contributingReports, excluded, minSampleSize);
  }

  const minCount = options.minCount ?? 1;
  const items: CategoryRankItem[] = [...counts.entries()]
    .filter(([, v]) => v.count >= minCount)
    .map(([key, v]) => {
      let label = key;
      let best = -1;
      for (const [text, freq] of v.labels) {
        if (freq > best) {
          best = freq;
          label = text;
        }
      }
      return {
        key,
        label,
        count: v.count,
        share: round(v.count / contributingReports, 4),
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ja'))
    .slice(0, options.topN ?? 10);

  return {
    status: 'ready',
    sampleSize: contributingReports,
    rawCount: perReport.length,
    totalMentions,
    excluded,
    items,
  };
}

/**
 * ある値が母集団の中で下から何%かを返す。
 * 投稿完了後の「あなたの勉強時間は◯%の位置」に使う。
 * n < MIN_SAMPLE_SIZE なら位置を返さない。
 */
export function percentileRankOf(
  values: readonly unknown[],
  target: unknown,
  options: NumericFieldOptions = {},
): PercentileResult {
  const minSampleSize = options.minSampleSize ?? MIN_SAMPLE_SIZE;
  const { valid, excluded } = collectNumbers(values, options);
  const n = valid.length;

  if (n < minSampleSize) {
    return collecting(n, excluded, minSampleSize);
  }
  const t = typeof target === 'number' ? target : Number(target);
  if (!Number.isFinite(t)) {
    return collecting(n, excluded, minSampleSize);
  }
  const below = valid.filter((v) => v < t).length;
  const equal = valid.filter((v) => v === t).length;
  // 同値は半分に配分(mid-rank)。0%/100%が出にくくなる
  const percentile = ((below + equal / 2) / n) * 100;

  return {
    status: 'ready',
    sampleSize: n,
    percentile: Math.min(99, Math.max(1, Math.round(percentile))),
  };
}

// ---------------------------------------------------------------------------
// まとめて計算する入口
// ---------------------------------------------------------------------------

export type ReportPayload = Record<string, unknown>;

export interface EntityMetrics {
  /** 集計対象にした投稿数(published のもの) */
  reportCount: number;
  minSampleSize: number;
  numeric: Record<string, NumericResult>;
  category: Record<string, CategoryResult>;
  computedAt: string;
}

/**
 * 公開済み投稿の payload 配列から、その entity の全メトリクスを計算する。
 * 返り値はそのまま metrics_cache.value に入れられる形。
 */
export function computeEntityMetrics(
  payloads: readonly ReportPayload[],
  config: MetricConfig = CERTIFICATION_METRIC_CONFIG,
): EntityMetrics {
  const numeric: Record<string, NumericResult> = {};
  const category: Record<string, CategoryResult> = {};

  for (const [field, options] of Object.entries(config.numeric ?? {})) {
    numeric[field] = summarizeNumeric(
      payloads.map((p) => p[field]),
      options,
    );
  }
  for (const [field, options] of Object.entries(config.category ?? {})) {
    category[field] = rankCategories(
      payloads.map((p) => p[field]),
      options,
    );
  }

  return {
    reportCount: payloads.length,
    minSampleSize: MIN_SAMPLE_SIZE,
    numeric,
    category,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 表示側のための型ガード / 文言
// ---------------------------------------------------------------------------

export function isReady<T extends { status: string }>(
  result: T | CollectingResult,
): result is Exclude<T, CollectingResult> {
  return result.status === 'ready';
}

/** 「n=42」のような併記文字列。表示側は必ずこれを添える(掟 3-3) */
export function sampleSizeLabel(result: { sampleSize: number }): string {
  return `n=${result.sampleSize}`;
}

/** 収集中の説明文。「もうすぐ出る」と誤解させない表現にする */
export function collectingMessage(result: CollectingResult): string {
  return `現在${result.sampleSize}件。あと${result.remaining}件の投稿が集まった時点で集計を公開する。`;
}
