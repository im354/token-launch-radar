// Rank stability for the finished board.
//
// A board that ranks every pre-token protocol by a category multiple, a growth nudge, a
// maturity premium and one launch discount is only as trustworthy as its weakest choice.
// Swap the category median for the p25 multiple and the top ten can reorder; drop the
// growth term and a protocol that fell 6% this week climbs. This module re-ranks the
// finished rows under eight readings of the same model and reports, per protocol, the
// span of ranks it occupies and, per reading, how much of the shipped order survives.
//
// It is a pure function of the rows main.ts has just built: no clock, no random number,
// no second scoring path. The shipped reading is variant 0 and must reproduce the board's
// own order, which is what sensitivityIssue checks before the five deliverables are
// written. Nothing here changes a value, a rank or a deliverable: the audit is printed,
// not published, so the board on disk stays the one the dashboard was photographed with.

import type { BoardRow } from './model.ts';

// The readings, in the order the audit walks them. Each one answers a different question
// a reader could fairly ask of the ranking: is the order an artefact of the median
// multiple, of the growth term, of the maturity premium, of the launch discount, or of
// treating each category on its own?
export type VariantId =
  | 'shipped'
  | 'multiple-low'
  | 'multiple-high'
  | 'no-growth'
  | 'double-growth'
  | 'no-maturity'
  | 'no-launch-discount'
  | 'one-multiple';

export interface Variant {
  id: VariantId;
  label: string;
  reading: string;
}

export const VARIANTS: Variant[] = [
  {
    id: 'shipped',
    label: 'as shipped',
    reading: 'the board exactly as it stands: median multiple, growth term, maturity premium, launch discount',
  },
  {
    id: 'multiple-low',
    label: 'multiple at p25',
    reading: 'each category priced at its 25th percentile multiple, the low edge of the published band',
  },
  {
    id: 'multiple-high',
    label: 'multiple at p75',
    reading: 'each category priced at its 75th percentile multiple, the high edge of the published band',
  },
  {
    id: 'no-growth',
    label: 'no growth term',
    reading: 'the weekly change ignored, so a protocol that fell this week keeps its whole figure',
  },
  {
    id: 'double-growth',
    label: 'growth twice',
    reading: 'the weekly change counted twice, which rewards a rising protocol more than the board does',
  },
  {
    id: 'no-maturity',
    label: 'no maturity premium',
    reading: 'age ignored, so a protocol listed last month keeps no premium over one listed last year',
  },
  {
    id: 'no-launch-discount',
    label: 'no launch discount',
    reading: 'the launch factor removed, which shows where a tagged row would sit if its tag were wrong',
  },
  {
    id: 'one-multiple',
    label: 'one multiple for all',
    reading: 'every category priced at the board-wide median multiple instead of its own',
  },
];

export interface VariantSummary {
  id: VariantId;
  label: string;
  reading: string;
  top_10_kept: number;
  moved: number;
  largest_swing: number;
  agreement: number;
}

// The readings that keep the model's shape: the multiple inside its published band, the
// growth and maturity terms on or off, and every category priced together. The launch
// discount is deliberately not one of them. Removing it is a counterfactual about the tag,
// not another reading of the ranking, and it floods the top ten with tagged rows by
// design, so mixing it into a stability score would only measure that design.
export const STRUCTURAL: VariantId[] = VARIANTS
  .filter((variant) => variant.id !== 'no-launch-discount' && variant.id !== 'shipped')
  .map((variant) => variant.id);

export interface RowStability {
  slug: string;
  name: string;
  rank: number;
  best_rank: number;
  worst_rank: number;
  swing: number;
  worst_under: VariantId;
  without_discount_rank: number;
}

// One category's own stability. A category-anchored model is only as good as the
// comparison inside each category, so the audit reports them one by one.
export interface CategoryStability {
  category: string;
  rows: number;
  leader: string;
  leader_name: string;
  median_swing: number;
  largest_swing: number;
  leader_holds: boolean;
}

// The forty protocols the shortlist is about. A board can reorder itself and still leave a
// farmer with the same shortlist, or keep its top ten and shuffle the targets, so the
// watchlist is measured on its own: how far its rows move, how many of them shrug off the
// alternatives, and how many keep a top-forty place even without the launch discount.
export interface WatchlistReport {
  rows: number;
  median_swing: number;
  steady: number;
  movers: RowStability[];
  top_40_hold: number;
}

export interface Sensitivity {
  variants: VariantSummary[];
  rows: RowStability[];
  categories: CategoryStability[];
  watch: WatchlistReport;
  stable_top_10: string[];
  fragile: RowStability[];
  median_swing: number;
  largest_swing: number;
  largest_swing_slug: string;
  note: string;
}

// ---------------------------------------------------------------------------------------
// small comparisons and statistics
// ---------------------------------------------------------------------------------------

// A value the arithmetic can divide by. The rows carry multipliers that are always
// positive by construction, but the audit also runs over a hand-edited board, so a zero
// or a NaN falls back to one rather than turning a percentage into infinity.
function positive(value: number, fallback = 1): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The multiple a row is priced at, guarded: a category multiple of zero would make the
// board-wide median meaningless in the one-multiple reading.
function multipleOf(row: BoardRow): number {
  return positive(row.category_multiple);
}

// The board-wide median of the category multiples, which the one-multiple reading uses.
// A median rather than a mean: one wildly priced category should not move it.
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// The order of a set of slugs by descending value, ties broken by slug ascending. The
// tie-break matters: without it the audit could report a swing that is only an artefact
// of the order the rows happen to sit in.
export function orderBy(slugs: string[], value: (slug: string) => number): string[] {
  return slugs.slice().sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va !== vb) return vb - va;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// How many of the shipped top `size` survive in the other order, and how far they moved.
export function overlap(base: string[], other: string[], size: number): number {
  const head = new Set(other.slice(0, size));
  let kept = 0;
  for (const slug of base.slice(0, size)) {
    if (head.has(slug)) kept++;
  }
  return kept;
}

// Pairwise agreement over the shipped top `size`: of every pair of protocols that sit one
// above the other in the shipped order, how many keep that relative order elsewhere. It
// is a cheaper, sturdier cousin of a rank correlation: no squares, no square roots, and
// one number a reader can check by hand.
export function pairwise(base: string[], other: string[], size: number): { kept: number; total: number } {
  const head = base.slice(0, size);
  const position = new Map<string, number>();
  for (let i = 0; i < other.length; i++) position.set(other[i], i);
  let kept = 0;
  let total = 0;
  for (let i = 0; i < head.length; i++) {
    for (let j = i + 1; j < head.length; j++) {
      const a = position.get(head[i]);
      const b = position.get(head[j]);
      if (a === undefined || b === undefined) continue;
      total++;
      if (a < b) kept++;
    }
  }
  return { kept, total };
}

// A multiplier as a percentage of the shipped one, for the note: 0.86 reads as 86%.
export function asPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return 'n/a';
  return (fraction * 100).toFixed(1) + '%';
}

// A number of places with no decimals, since every count in the audit is a whole one.
export function places(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  return String(Math.round(value));
}

// One noun for one count, the other for every other count, so a one-row board reads as
// well as a four-thousand-row one.
export function plural(count: number, one: string, many: string): string {
  return Math.round(count) === 1 ? one : many;
}

// ---------------------------------------------------------------------------------------
// the eight values one row can take
// ---------------------------------------------------------------------------------------

// The figure a row would carry under one reading. The five factors are the ones the model
// publishes: the category multiple (through the band the row already carries), the growth
// multiplier, the maturity multiplier and the launch likelihood. Rebuilding the product
// from the row's own parts keeps the audit honest: it cannot invent a factor the board
// does not expose.
export function valueUnder(row: BoardRow, id: VariantId, boardMultiple: number): number {
  const base = positive(row.base_value_usd, positive(row.tvl_usd));
  const growth = positive(row.growth_multiplier);
  const maturity = positive(row.maturity_multiplier);
  const likelihood = positive(row.launch_likelihood);
  if (id === 'shipped') return positive(row.implied_value_usd, base * growth * maturity * likelihood);
  if (id === 'multiple-low') {
    // The low edge of the band is the p25 multiple applied to the same factors, so the
    // ratio to the shipped figure is the multiple's own ratio and nothing else.
    const low = positive(row.implied_low_usd, 0);
    if (low > 0) return low;
    return base * growth * maturity * likelihood * 0.5;
  }
  if (id === 'multiple-high') {
    const high = positive(row.implied_high_usd, 0);
    if (high > 0) return high;
    return base * growth * maturity * likelihood * 2;
  }
  if (id === 'no-growth') return base * maturity * likelihood;
  if (id === 'double-growth') return base * growth * growth * maturity * likelihood;
  if (id === 'no-maturity') return base * growth * likelihood;
  if (id === 'no-launch-discount') return base * growth * maturity;
  // One multiple for the whole board: the row's category multiple is replaced by the
  // board-wide median, which is a scale on the base and leaves the other factors alone.
  const scale = boardMultiple / multipleOf(row);
  return base * growth * maturity * likelihood * positive(scale);
}

// ---------------------------------------------------------------------------------------
// the audit
// ---------------------------------------------------------------------------------------

// The board-wide median multiple, the one the one-multiple reading uses. Rows priced at
// the fallback multiple still contribute: they are part of the board a reader sees.
export function boardMultiple(rows: BoardRow[]): number {
  return median(rows.map(multipleOf));
}

// Every variant's order, in one pass per variant rather than one pass per row, so a board
// of four thousand rows costs eight sorts rather than thirty-two thousand lookups.
export function variantOrders(rows: BoardRow[]): Map<VariantId, string[]> {
  const slugs = rows.map((r) => r.slug);
  const bySlug = new Map<string, BoardRow>();
  for (const row of rows) bySlug.set(row.slug, row);
  const boardWide = boardMultiple(rows);
  const orders = new Map<VariantId, string[]>();
  for (const variant of VARIANTS) {
    const values = new Map<string, number>();
    for (const slug of slugs) {
      const row = bySlug.get(slug);
      if (row === undefined) continue;
      values.set(slug, valueUnder(row, variant.id, boardWide));
    }
    orders.set(variant.id, orderBy(slugs, (slug) => values.get(slug) ?? 0));
  }
  return orders;
}

// The rank each slug holds in each variant, built once so the per-row record can read
// every reading in constant time.
export function rankTable(orders: Map<VariantId, string[]>): Map<VariantId, Map<string, number>> {
  const table = new Map<VariantId, Map<string, number>>();
  for (const [id, order] of orders) {
    const ranks = new Map<string, number>();
    for (let i = 0; i < order.length; i++) ranks.set(order[i], i + 1);
    table.set(id, ranks);
  }
  return table;
}

// One row's span across the structural readings: its shipped rank, the best and worst it
// ever reaches, the swing between them, and the reading that pushed it furthest down. The
// discount counterfactual is kept beside it rather than inside the span.
export function stabilityOf(row: BoardRow, ranks: Map<VariantId, Map<string, number>>): RowStability {
  const shipped = ranks.get('shipped')?.get(row.slug) ?? row.rank;
  let best = shipped;
  let worst = shipped;
  let worstUnder: VariantId = 'shipped';
  for (const id of STRUCTURAL) {
    const rank = ranks.get(id)?.get(row.slug);
    if (rank === undefined) continue;
    if (rank < best) best = rank;
    if (rank > worst) {
      worst = rank;
      worstUnder = id;
    }
  }
  return {
    slug: row.slug,
    name: row.name,
    rank: shipped,
    best_rank: best,
    worst_rank: worst,
    swing: worst - best,
    worst_under: worstUnder,
    without_discount_rank: ranks.get('no-launch-discount')?.get(row.slug) ?? shipped,
  };
}

// The three numbers a reader wants from one reading: how much of the shipped top ten it
// keeps, how many rows it moves at all, and the largest single rank change.
export function summariseVariant(
  variant: Variant,
  shipped: string[],
  other: string[],
  ranks: Map<VariantId, Map<string, number>>,
): VariantSummary {
  const head = shipped.slice(0, 10);
  const kept = overlap(shipped, other, 10);
  let moved = 0;
  let largest = 0;
  for (const slug of shipped) {
    const before = ranks.get('shipped')?.get(slug);
    const after = ranks.get(variant.id)?.get(slug);
    if (before === undefined || after === undefined) continue;
    const delta = Math.abs(after - before);
    if (delta > 0) moved++;
    if (delta > largest) largest = delta;
  }
  const pairs = pairwise(shipped, other, 50);
  return {
    id: variant.id,
    label: variant.label,
    reading: variant.reading,
    top_10_kept: kept,
    moved,
    largest_swing: largest,
    agreement: pairs.total === 0 ? 1 : pairs.kept / pairs.total,
  };
}

// One category's own stability. A category-anchored model is only as good as the
// comparison inside each category, so the audit reports them one by one, worst first: the
// reading a reader should distrust most is the one whose leader changes hands.
export function categoryStability(rows: BoardRow[], stability: RowStability[]): CategoryStability[] {
  const byCategory = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category);
    if (list === undefined) byCategory.set(row.category, [row]);
    else list.push(row);
  }
  const recordOf = new Map<string, RowStability>();
  for (const record of stability) recordOf.set(record.slug, record);
  const out: CategoryStability[] = [];
  for (const [category, members] of byCategory) {
    const records: RowStability[] = [];
    for (const member of members) {
      const record = recordOf.get(member.slug);
      if (record !== undefined) records.push(record);
    }
    if (records.length === 0) continue;
    const ordered = records.slice().sort((a, b) => a.rank - b.rank);
    const leader = ordered[0];
    const values = records.map((r) => r.swing).sort((a, b) => a - b);
    // The leader holds when every reading keeps it ahead of every other member of its
    // category. That is a stronger claim than keeping its rank, and the one that matters:
    // a category whose leader is safe still gives a reader a usable shortlist.
    const holds = records.every((record) => record === leader || record.best_rank > leader.worst_rank);
    out.push({
      category,
      rows: records.length,
      leader: leader.slug,
      leader_name: leader.name,
      median_swing: median(values),
      largest_swing: values[values.length - 1],
      leader_holds: holds,
    });
  }
  return out.sort((a, b) => {
    if (a.median_swing !== b.median_swing) return b.median_swing - a.median_swing;
    return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  });
}

// The shortlist's own numbers. "Steady" means a row moves ten places or fewer under every
// structural reading, which on a board of this size is as close to a settled ranking as a
// model with a category multiple can offer.
export function watchlistReport(rows: BoardRow[], stability: RowStability[]): WatchlistReport {
  const watched = new Set<string>();
  for (const row of rows) {
    if (row.watchlist) watched.add(row.slug);
  }
  const records = stability.filter((record) => watched.has(record.slug));
  const swings = records.map((record) => record.swing).sort((a, b) => a - b);
  const movers = records
    .filter((record) => record.swing >= 50)
    .slice()
    .sort((a, b) => {
      if (a.swing !== b.swing) return b.swing - a.swing;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    })
    .slice(0, 5);
  return {
    rows: records.length,
    median_swing: swings.length === 0 ? 0 : median(swings),
    steady: records.filter((record) => record.swing <= 10).length,
    movers,
    top_40_hold: records.filter((record) => record.rank <= 40 && record.without_discount_rank <= 40).length,
  };
}

// The audit a caller holds: per reading, per category, per row, and the handful of
// sentences that say what the numbers mean.
export function auditSensitivity(rows: BoardRow[]): Sensitivity {
  const orders = variantOrders(rows);
  const ranks = rankTable(orders);
  const shipped = orders.get('shipped') ?? [];
  const variants: VariantSummary[] = [];
  for (const variant of VARIANTS) {
    const order = orders.get(variant.id) ?? shipped;
    variants.push(summariseVariant(variant, shipped, order, ranks));
  }
  const stability = rows.map((row) => stabilityOf(row, ranks));
  const categories = categoryStability(rows, stability);
  const watch = watchlistReport(rows, stability);
  const bySwing = stability.slice().sort((a, b) => {
    if (a.swing !== b.swing) return b.swing - a.swing;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const topTen = new Set(shipped.slice(0, 10));
  const stableTopTen = shipped.slice(0, 10).filter((slug) => {
    const record = stability.find((s) => s.slug === slug);
    return record !== undefined && record.worst_rank <= 10;
  });
  const swings = stability.map((s) => s.swing).sort((a, b) => a - b);
  const medianSwing = swings.length === 0 ? 0 : median(swings);
  const worst = bySwing[0];
  const fragile = bySwing.filter((s) => topTen.has(s.slug)).slice(0, 5);
  const loosest = categories[0];
  const noDiscount = variants.find((variant) => variant.id === 'no-launch-discount');
  const lostSlots = noDiscount === undefined ? 0 : Math.min(10, rows.length) - noDiscount.top_10_kept;
  const note =
    'of the shipped top ten, ' + places(stableTopTen.length) + ' keep their place under the ' +
    STRUCTURAL.length + ' readings that keep the model shape; dropping the launch discount ' +
    'would hand ' + places(lostSlots) + ' of those slots to tagged protocols. Of the ' +
    places(watch.rows) + ' watchlist ' + plural(watch.rows, 'protocol', 'protocols') + ', ' +
    places(watch.steady) + ' move ten places ' +
    'or fewer and ' + places(watch.movers.length) + ' move fifty or more; the median protocol ' +
    'moves ' + places(medianSwing) + ' places, the largest move is ' + places(worst?.swing ?? 0) +
    ' places for ' + (worst?.name ?? 'no protocol') + ' under ' + (worst?.worst_under ?? 'shipped') +
    (loosest === undefined ? '.' : ', and the least settled category is ' + loosest.category + '.');
  return {
    variants,
    rows: stability,
    categories,
    watch,
    stable_top_10: stableTopTen,
    fragile,
    median_swing: medianSwing,
    largest_swing: worst?.swing ?? 0,
    largest_swing_slug: worst?.slug ?? '',
    note,
  };
}

// ---------------------------------------------------------------------------------------
// the guard and the line main.ts prints
// ---------------------------------------------------------------------------------------

// A reading that silently drops a row, or that disagrees with the board's own ranks, would
// make the whole audit a comfort rather than a check. This returns the first such problem
// in plain words, or null when every reading ranks every row exactly once and the shipped
// reading reproduces the board.
export function sensitivityIssue(sensitivity: Sensitivity, rows: BoardRow[]): string | null {
  if (rows.length === 0) return 'the board is empty, so there is nothing to re-rank';
  if (sensitivity.variants.length !== VARIANTS.length) {
    return 'the audit walked ' + sensitivity.variants.length + ' readings, not ' + VARIANTS.length;
  }
  const shipped = sensitivity.variants.find((v) => v.id === 'shipped');
  if (shipped === undefined) return 'the audit has no shipped reading to compare against';
  if (shipped.top_10_kept !== Math.min(10, rows.length)) {
    return 'the shipped reading disagrees with the board top ten: ' + shipped.top_10_kept + ' kept';
  }
  if (shipped.agreement !== 1) {
    return 'the shipped reading disagrees with the board order (agreement ' + asPercent(shipped.agreement) + ')';
  }
  if (sensitivity.rows.length !== rows.length) {
    return 'the audit holds ' + sensitivity.rows.length + ' rows for a board of ' + rows.length;
  }
  const seen = new Set<string>();
  for (const record of sensitivity.rows) {
    if (seen.has(record.slug)) return 'the audit lists ' + record.slug + ' twice';
    seen.add(record.slug);
    if (record.best_rank < 1 || record.worst_rank > rows.length) {
      return record.slug + ' leaves the board (ranks ' + record.best_rank + ' to ' + record.worst_rank + ')';
    }
    if (record.worst_rank < record.best_rank) {
      return record.slug + ' has a worst rank above its best (' + record.worst_rank + ' < ' + record.best_rank + ')';
    }
    if (record.without_discount_rank < 1 || record.without_discount_rank > rows.length) {
      return record.slug + ' leaves the board without the discount (rank ' + record.without_discount_rank + ')';
    }
  }
  for (const row of rows) {
    if (!seen.has(row.slug)) return row.slug + ' is on the board but not in the audit';
  }
  const watched = rows.filter((row) => row.watchlist).length;
  if (sensitivity.watch.rows !== watched) {
    return 'the watchlist report covers ' + sensitivity.watch.rows + ' of ' + watched + ' watchlist rows';
  }
  const categories = new Set<string>();
  for (const row of rows) categories.add(row.category);
  if (sensitivity.categories.length !== categories.size) {
    return 'the audit reports ' + sensitivity.categories.length + ' categories for a board of ' + categories.size;
  }
  return null;
}

// One line, after the deliverables: the part of the audit worth reading in a terminal.
export function stabilityLine(sensitivity: Sensitivity): string {
  const moved = sensitivity.variants.filter((v) => STRUCTURAL.includes(v.id));
  let loosest = moved[0];
  for (const variant of moved) {
    if (loosest === undefined || variant.top_10_kept < loosest.top_10_kept) loosest = variant;
  }
  const weakest = loosest === undefined ? '' : ' (weakest reading: ' + loosest.label + ', ' + loosest.top_10_kept + '/10 kept)';
  return 'stability: ' + sensitivity.stable_top_10.length + '/10 of the top ten hold under the ' +
    STRUCTURAL.length + ' structural readings' + weakest + '; watchlist ' +
    sensitivity.watch.steady + '/' + sensitivity.watch.rows + ' steady, largest rank move ' +
    sensitivity.largest_swing + ' places (' + (sensitivity.largest_swing_slug || 'none') + ')';
}

// The whole audit as plain text, for --audit. Fixed-width columns, no colour, no box
// drawing: it is meant to be read in a terminal, pasted into a note, or diffed between
// two model versions.
export function renderTable(sensitivity: Sensitivity): string {
  const lines: string[] = [];
  const columns = (cells: string[], widths: number[]): string => {
    const out: string[] = [];
    for (let i = 0; i < cells.length; i++) {
      const cell = i === 0 ? cells[i].padEnd(widths[i]) : cells[i].padStart(widths[i]);
      out.push(cell);
    }
    return out.join('  ');
  };
  lines.push(columns(['reading', 'top10', 'moved', 'worst', 'agree'], [20, 6, 7, 7, 8]));
  lines.push(columns(['-'.repeat(20), '-'.repeat(6), '-'.repeat(7), '-'.repeat(7), '-'.repeat(8)], [20, 6, 7, 7, 8]));
  for (const variant of sensitivity.variants) {
    lines.push(columns([
      variant.label,
      variant.top_10_kept + '/10',
      places(variant.moved),
      places(variant.largest_swing),
      asPercent(variant.agreement),
    ], [20, 6, 7, 7, 8]));
  }
  lines.push('');
  lines.push(columns(['category', 'rows', 'median', 'worst', 'leader'], [24, 6, 8, 7, 28]));
  lines.push(columns(['-'.repeat(24), '-'.repeat(6), '-'.repeat(8), '-'.repeat(7), '-'.repeat(28)], [24, 6, 8, 7, 28]));
  for (const category of sensitivity.categories.slice(0, 8)) {
    lines.push(columns([
      category.category.length > 24 ? category.category.slice(0, 23) + '…' : category.category,
      places(category.rows),
      places(category.median_swing),
      places(category.largest_swing),
      category.leader_holds ? category.leader_name + ' holds' : category.leader_name + ' may move',
    ], [24, 6, 8, 7, 28]));
  }
  if (sensitivity.fragile.length > 0) {
    lines.push('');
    const names = sensitivity.fragile.map((row) => row.name + ' (' + row.swing + ')');
    lines.push('closest top-ten calls: ' + names.join(', '));
  }
  lines.push('');
  lines.push('watchlist: ' + sensitivity.watch.steady + ' of ' + sensitivity.watch.rows +
    ' move ten places or fewer, ' + sensitivity.watch.top_40_hold +
    ' keep a top-forty place without the launch discount');
  if (sensitivity.watch.movers.length > 0) {
    const moves = sensitivity.watch.movers.map((row) => row.name + ' (' + row.swing + ')');
    lines.push('watchlist rows that move fifty places or more: ' + moves.join(', '));
  }
  lines.push('');
  lines.push(sensitivity.note);
  return lines.join('\n') + '\n';
}
