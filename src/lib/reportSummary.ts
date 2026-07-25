/**
 * ビルド時点の投稿集計を読む。
 *
 * 投稿の実体は D1 にあるが、サイトは静的生成なのでビルド時にスナップショットを
 * `data/metrics/<slug>.json` へ書き出しておき、それを埋め込む。
 * ファイルが無ければ「投稿ゼロ」として扱う。**これが正常な初期状態**であり、
 * 投稿が無くてもページは第1層(公式統計)で成立する(ADR-007)。
 *
 * 集計の中身は src/lib/metrics.ts が生成する。n<20 で統計値を返さない規則は
 * そちら側で強制されているため、ここでは受け取った形をそのまま使う。
 */
import { MIN_SAMPLE_SIZE } from '../config';

export interface StudyHoursSummary {
  status: 'collecting' | 'ready';
  sampleSize: number;
  /** status==='ready' のときだけ入る */
  median?: number;
  q1?: number;
  q3?: number;
  bins?: Array<{ from: number; to: number | null; count: number }>;
}

export interface ReportSnapshot {
  slug: string;
  updatedAt: string;
  totalReports: number;
  studyHours: StudyHoursSummary;
}

const modules = import.meta.glob<ReportSnapshot>('../../data/metrics/*.json', {
  eager: true,
  import: 'default',
});

const bySlug = new Map<string, ReportSnapshot>();
for (const snap of Object.values(modules)) {
  if (snap?.slug) bySlug.set(snap.slug, snap);
}

/** 投稿がまだ無い資格のための空スナップショット */
export function emptySnapshot(slug: string): ReportSnapshot {
  return {
    slug,
    updatedAt: '',
    totalReports: 0,
    studyHours: { status: 'collecting', sampleSize: 0 },
  };
}

export function getSnapshot(slug: string): ReportSnapshot {
  return bySlug.get(slug) ?? emptySnapshot(slug);
}

/** 公開ラインまであと何件か。0 なら公開済み */
export function remainingToPublish(snapshot: ReportSnapshot): number {
  return Math.max(0, MIN_SAMPLE_SIZE - snapshot.studyHours.sampleSize);
}
