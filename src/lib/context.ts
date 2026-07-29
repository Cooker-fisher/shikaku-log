/**
 * 掲載中の資格どうしを見比べるための位置づけ計算。
 *
 * ============================================================
 * なぜ作るのか(2026-07-28)
 * ============================================================
 * 資格ページは「合格率 18.7%」と大きく出しておきながら、
 * **それが難しいのかどうかを一度も答えていなかった。**
 * 18.7% が難関なのか、誰でも受かるのかは、比べる相手がなければ判断できない。
 *
 * このサイトは17資格分の合格率を持っている。**一度も使っていなかった。**
 * 読者が最初に抱く問い(「で、これは難しいの?」)に答えられる材料を
 * 持ったまま、各ページを孤立した数字置き場にしていた。
 *
 * ============================================================
 * 誠実さの制約
 * ============================================================
 * **試験が違えば受ける人も違う。**宅建の18.7%と簿記3級の合格率を並べて
 * 「宅建のほうが難しい」と言い切ることはできない。受験資格も、母集団の
 * 準備度合いも、問題の性質も違う。
 *
 * したがってこの関数は**順位という事実だけ**を返し、難易度の断定はしない。
 * 表示側では必ず「このサイトに載っている◯資格の中で」と範囲を明示し、
 * 母集団が違うことを添えること(掟 3-7: 推測を事実として書かない)。
 */
import { entities, statBlocks, latestSeries } from './entities';

export interface PeerRow {
  slug: string;
  shortName: string;
  category: string;
  passRate: number;
  /** 複数の統計ブロックを持つ試験で、どの系列の数字かを示す(簿記の統一試験など) */
  seriesNote?: string;
}

export interface DifficultyContext {
  /** 比較に使えた資格の数。**必ず表示に併記する** */
  total: number;
  /** 合格率が低い順の順位(1 = 最も低い) */
  rankFromHardest: number;
  passRate: number;
  min: number;
  max: number;
  median: number;
  /** 合格率の低い順に並べた全資格。棒グラフと内部リンクに使う */
  peers: PeerRow[];
}

/** 掲載中の全資格の、主系列の最新合格率を取り出す */
function allRates(): PeerRow[] {
  const rows: PeerRow[] = [];
  for (const e of entities) {
    const blocks = statBlocks(e);
    const primary = blocks[0];
    if (!primary) continue;
    const latest = latestSeries(primary.stats);
    if (!latest || latest.pass_rate === null || latest.pass_rate === undefined) continue;
    rows.push({
      slug: e.slug,
      shortName: e.short_name,
      category: e.category,
      passRate: latest.pass_rate,
      // 統計ブロックが複数ある試験は、どの系列の数字かを添えないと誤読される
      seriesNote: blocks.length > 1 ? primary.label : undefined,
    });
  }
  return rows.sort((a, b) => a.passRate - b.passRate);
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  const lo = s[mid - 1] ?? hi;
  return s.length % 2 ? hi : (lo + hi) / 2;
}

/**
 * この資格が、掲載中の資格の中でどのあたりに位置するか。
 *
 * 比較できる相手が少なすぎるときは null を返す。
 * **3件や4件での「下から2番目」は位置づけとして意味を持たない**ので、
 * 表示そのものを出さない(掟 3-5 と同じ考え方: 少ないnで順位を語らない)。
 */
export function difficultyContext(slug: string, minPeers = 8): DifficultyContext | null {
  const peers = allRates();
  if (peers.length < minPeers) return null;

  const idx = peers.findIndex((p) => p.slug === slug);
  if (idx === -1) return null;

  const rates = peers.map((p) => p.passRate);
  const self = peers[idx];
  const min = rates[0];
  const max = rates[rates.length - 1];
  // minPeers >= 1 を通っているので値は必ず在るが、型の上では確定していない
  if (self === undefined || min === undefined || max === undefined) return null;

  return {
    total: peers.length,
    rankFromHardest: idx + 1,
    passRate: self.passRate,
    min,
    max,
    median: medianOf(rates),
    peers,
  };
}
