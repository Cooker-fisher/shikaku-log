/**
 * 資格データ(entities)の読み込みと整形。
 *
 * データは site/data/entities/*.json に置く。将来 D1 の entities テーブルへ
 * 移すが、公式統計は更新頻度が年1回程度なのでビルド時に静的に埋め込む方が速い。
 * 2号店(住まい・お金のDB)でも type を変えるだけで同じ構造が使える。
 */

export interface StatSeries {
  /** 年度表記。ネット試験のように年度単位でないものは period を使う */
  year?: string;
  period?: string;
  session?: string;
  date?: string;
  applicants: number | null;
  examinees: number | null;
  passers: number | null;
  pass_rate: number | null;
  source_url?: string;
  retrieved_at?: string;
}

export interface OfficialStats {
  unit: string;
  series: StatSeries[];
  source_url: string;
  retrieved_at: string;
  notes?: string;
  unit_labels?: Record<string, string>;
}

export interface Entity {
  type: string;
  slug: string;
  name: string;
  short_name: string;
  category: string;
  authority: { name: string; url: string };
  exam: {
    eligibility: string;
    fee_yen: number | null;
    format: string;
    questions: number | null;
    duration_minutes: number | null;
    passing_criteria: string;
    frequency: string;
    result_announcement: string;
    /** 項目ごとの出典。1つのURLで複数項目をまとめて根拠づけない(CLAUDE.md 3-1b) */
    source_urls?: Record<string, string>;
    source_url?: string;
    fee_note?: string;
    retrieved_at: string;
  };
  official_stats?: OfficialStats;
  official_stats_unified?: OfficialStats;
  official_stats_cbt?: OfficialStats;
  cbt_details?: Record<string, unknown>;
  unified_2026_schedule?: Record<string, unknown>;
  schedule_url?: string;
  schedule_url_note?: string;
  verification?: Record<string, string>;
  notes?: string;
}

const modules = import.meta.glob<Entity>('../../data/entities/*.json', {
  eager: true,
  import: 'default',
});

export const entities: Entity[] = Object.values(modules);

export function getEntity(slug: string): Entity | undefined {
  return entities.find((e) => e.slug === slug);
}

/**
 * この資格が持つ統計ブロックを、表示順に並べて返す。
 * 簿記のように統一試験とネット試験で別集計の資格があるため配列で扱う。
 */
export function statBlocks(entity: Entity): Array<{ key: string; label: string; stats: OfficialStats }> {
  const blocks: Array<{ key: string; label: string; stats: OfficialStats }> = [];
  if (entity.official_stats) {
    blocks.push({ key: 'main', label: '公式統計', stats: entity.official_stats });
  }
  if (entity.official_stats_unified) {
    blocks.push({ key: 'unified', label: '統一試験(ペーパー)', stats: entity.official_stats_unified });
  }
  if (entity.official_stats_cbt) {
    blocks.push({ key: 'cbt', label: 'ネット試験(CBT)', stats: entity.official_stats_cbt });
  }
  return blocks;
}

/** 系列のラベル(年度 / 回次 / 期間)を1つの文字列にする */
export function seriesLabel(s: StatSeries): string {
  if (s.session) return s.session;
  if (s.year) return s.year;
  if (s.period) return s.period;
  return '';
}

/** 直近の系列(配列の先頭が最新である前提。データ投入時に守る) */
export function latestSeries(stats: OfficialStats): StatSeries | undefined {
  return stats.series[0];
}

/**
 * 合格率の推移から、直近と5年平均の差を返す。
 * 「今年は例年より難しかったのか」という読者の疑問に直接答えるための値。
 */
export function passRateTrend(stats: OfficialStats): { latest: number; average: number; diff: number } | null {
  const rates = stats.series.map((s) => s.pass_rate).filter((r): r is number => typeof r === 'number');
  if (rates.length < 2) return null;
  const latest = rates[0];
  const average = rates.reduce((a, b) => a + b, 0) / rates.length;
  return { latest, average, diff: Number((latest - average).toFixed(1)) };
}

/** 出典URLを項目名から引く。項目別の出典がなければブロック共通のものを返す */
export function sourceFor(entity: Entity, field: string): string | undefined {
  return entity.exam.source_urls?.[field] ?? entity.exam.source_url;
}
