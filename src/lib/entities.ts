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
  /** 読者向けの短い注記。内部メモ(notes)とは分けて扱う */
  public_note?: string;
  notes?: string;
  unit_labels?: Record<string, string>;
}

export interface RegionalRow {
  pref: string;
  applicants: number;
  examinees: number;
  exam_rate: number;
  passers: number;
  pass_rate: number;
}

/**
 * 都道府県別の集計。実施団体が公表している資格にのみ存在する。
 *
 * **これは AI Overviews 対策の主力になる**([backlog B-006])。
 * 「合格率は◯%」は数値1個で完結するのでAIの要約に奪われるが、
 * 47行の分布は表そのものが答えなので、要約すると価値が消える。
 */
export interface RegionalStats {
  year: string;
  rows: RegionalRow[];
  source_url: string;
  retrieved_at: string;
  public_note?: string;
  unit_labels?: Record<string, string>;
}

export interface Entity {
  type: string;
  slug: string;
  /**
   * true の間はページを生成しない(sitemap にも一覧にも出ない)。
   *
   * 波のゲート([ADR-003])を通る前に用意したデータを、デプロイのたびに
   * 意図せず公開してしまう事故を防ぐためのフラグ。データは先に集めてよいが、
   * 公開はゲート判定を通ってから `draft` を外して行う。
   * fact-checker の検証が済んでいないものにも付けておく。
   */
  draft?: boolean;
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
  regional_stats?: RegionalStats;
  /**
   * 自己採点ページの設定。**全受験者が同一問題を解く一斉試験にのみ持たせる。**
   * 都道府県ごとに問題が違う試験(危険物)やランダム出題(簿記CBT)では
   * 選択肢の分布が意味を持たない([backlog B-013])。
   */
  saiten?: {
    /** APIに渡す識別子。例: 'takken-2026' */
    exam_key: string;
    exam_date: string;
    questions: number;
    questions_exempt: number | null;
    exempt_label?: string;
  };
  /**
   * 合格基準点の推移。事前に合格点が公表されない試験にのみ存在する。
   * 「◯点で合格」と断定しないための根拠として使う([backlog B-013])。
   */
  passing_score_history?: {
    series: Array<{ year: string; general: number; exempt: number | null }>;
    total_questions: number;
    total_questions_exempt: number;
    source_url: string;
    retrieved_at: string;
    public_note?: string;
  };
  cbt_details?: Record<string, unknown>;
  unified_2026_schedule?: Record<string, unknown>;
  schedule_url?: string;
  schedule_url_note?: string;
  verification?: Record<string, string>;
  /** 読者向けの短い注記。内部メモ(notes)は表示しない */
  public_note?: string;
  notes?: string;
}

const modules = import.meta.glob<Entity>('../../data/entities/*.json', {
  eager: true,
  import: 'default',
});

/**
 * 投稿APIが受け付ける entity type。
 * functions/api/report.ts の SCHEMAS と src/lib/validation.ts の
 * CERTIFICATION_REPORT_SCHEMA に対応する。
 *
 * ここを揃え忘れると「ページは表示されるのに投稿だけ 404」という、
 * 本番で投稿を試すまで気づかない不具合になる(2026-07-25に実際に発生)。
 * ビルド時に落として気づけるようにする。
 */
const KNOWN_ENTITY_TYPES = new Set(['certification']);

/** 下書きを含む全件。集計や検算など、公開可否と関係ない用途にだけ使う */
export const allEntities: Entity[] = Object.values(modules);

/**
 * 公開対象の entity。**ページ生成・一覧・sitemap は必ずこちらを使う。**
 * `draft: true` のものはここに入らないので、デプロイしても公開されない。
 */
export const entities: Entity[] = allEntities.filter((e) => !e.draft);

for (const e of allEntities) {
  if (!KNOWN_ENTITY_TYPES.has(e.type)) {
    throw new Error(
      `entity "${e.slug}" の type が "${e.type}" になっている。` +
        `投稿APIが照合できる type は ${[...KNOWN_ENTITY_TYPES].join(' / ')} のみ。` +
        `data/entities/${e.slug}.json を直すこと。`,
    );
  }
}

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
  const latest = rates[0];
  if (rates.length < 2 || latest === undefined) return null;
  const average = rates.reduce((a, b) => a + b, 0) / rates.length;
  return { latest, average, diff: Number((latest - average).toFixed(1)) };
}

/** 出典URLを項目名から引く。項目別の出典がなければブロック共通のものを返す */
export function sourceFor(entity: Entity, field: string): string | undefined {
  return entity.exam.source_urls?.[field] ?? entity.exam.source_url;
}
