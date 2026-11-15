// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// Two sets, never mixed. A protocol is PRE-TOKEN when the snapshot records no token for it at all:
// gecko_id and symbol are both null. Every other protocol ALREADY TRADES, and goes to the reference
// table with the market cap it really has; no trading protocol is ever scored or ranked here.
//
// The board covers every pre-token protocol in the snapshot (342 of them on this input), not just the
// watchlist. The watchlist's 40 slugs are flagged as such. The protocols the watchlist's own definition
// leaves out stay on the board and are tagged launch_unlikely with the reason, because a bridge or a
// staked receipt is still a protocol a reader may want to see: it just is not a launch. The exclusion
// logic below mirrors the definition printed in the input README, rule for rule. It does not exclude
// anything by name that the definition does not exclude, and no individual protocol is special-cased.
//
// IMPLIED VALUE is category-anchored. From the protocols that already trade, per category:
//
//   peer multiple    = mcap_usd / tvl_usd                       (only where both are positive)
//   category multiple = the median of those multiples           (needs >= 3 peers, else the global median)
//   band              = the 25th and 75th percentiles of the same multiples
//
// Then, for a pre-token protocol:
//
//   base      = tvl_usd x category multiple
//   growth    = 1 + clamp(change_7d, -30, 60) / 100 x 0.5      (change_7d null: 1)
//   maturity  = 0.7 + 0.3 x min(years since listed_at, 5) / 5  (listed_at null: 1 year)
//   figure    = clamp(round(base x growth x maturity), 1, 100T)   the value the figures imply
//   launch    = 1 for a plausible launch, else the launch factor f below
//   implied   = clamp(round(figure x launch), 1, 100T)
//   low/high  = the same arithmetic with the 25th/75th percentile multiple
//   airdrop   = implied x 0.05 community allocation x 0.10 assumed eligibility share
//
// The launch factor is what makes "ranked below the plausible launches" work without an out-of-order
// sort: the gate refuses a board whose implied value rises as rank ascends, so the ordering has to come
// out of the value. A bridge's or an exchange's own token is not a launch the reader is waiting for, so
// its value is discounted by the launch factor f, and the same factor scales its band and its airdrop.
//
//   f = min(2%, band_share x the weakest plausible launch's figure / the largest tagged figure)
//
// The second term is what guarantees the ordering rather than merely suggesting it: a bridge with
// billions of TVL can imply more than a small plausible launch even at 2%, so f is shortened on this
// snapshot until every tagged row sits at or below `band_share` (90%) of the weakest plausible figure.
// It is one number for the whole board, so the tagged rows keep their order among themselves, and the
// arithmetic is still a pure function of the snapshot. The factor applied is written into the data
// (`assumptions.launch_likelihood`) and the page states it, so a reader can see the discount.
//
// The airdrop figure is a stated assumption, never a promise. Rank is implied value descending, ties
// broken by TVL and then slug; every plausible launch ranks above every tagged protocol. A launch_unlikely
// row also carries `plausible_rank`, its position among the plausible launches alone, so a page can show
// that standing beside the whole-board rank.
//
// Everything here is a pure function of the snapshot: no clock, no randomness, no network, no name
// special-cased anywhere. Same bytes in, same board out.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  /** Weight of the seven-day growth adjustment. */
  growth_weight: number;
  /** The growth figure is clamped into [growth_floor, growth_cap] per cent before weighting. */
  growth_floor: number;
  growth_cap: number;
  /** maturity = maturity_floor + maturity_range x min(years, maturity_cap_years) / maturity_cap_years. */
  maturity_floor: number;
  maturity_range: number;
  maturity_cap_years: number;
  /** Years assumed when listed_at is unknown. */
  unknown_age_years: number;
  /** A category needs this many trading peers before its own multiple is used. */
  min_category_samples: number;
  /** Share of the implied value assumed to go to a community allocation. */
  community_allocation: number;
  /** Share of that allocation a single farming wallet is assumed to receive. */
  eligibility_share: number;
  /** Implied value is clamped into [min_implied_usd, max_implied_usd]. */
  min_implied_usd: number;
  max_implied_usd: number;
  /**
   * The launch-likelihood factors. A plausible pre-token protocol keeps the whole value its figures imply
   * (1). A protocol the watchlist's definition leaves out is discounted: at most 2% of that value, and
   * less when 2% would still leave it above the weakest plausible launch (see `launch_band_share`).
   */
  launch_likelihood_plausible: number;
  launch_likelihood_unlikely: number;
  /**
   * The ceiling the largest tagged figure is discounted to, as a share of the weakest plausible launch's
   * figure: 0.9 puts every launch_unlikely row strictly below every plausible one while keeping their
   * order among themselves.
   */
  launch_band_share: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -30,
  growth_cap: 60,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_cap_years: 5,
  unknown_age_years: 1,
  min_category_samples: 3,
  community_allocation: 0.05,
  eligibility_share: 0.1,
  min_implied_usd: 1,
  max_implied_usd: 100_000_000_000_000,
  launch_likelihood_plausible: 1,
  launch_likelihood_unlikely: 0.02,
  launch_band_share: 0.9,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** One line the page can print under the title. */
export const MODEL_SUMMARY =
  'Implied value = TVL x the median market-cap-to-TVL multiple of the protocols already trading in the same category, adjusted for 7-day growth and for how long the protocol has run with no token; a protocol the watchlist definition leaves out is discounted by the launch factor and ranks below every plausible launch.';

/** The board's gate limits: a board of fewer or more rows is refused before it is written. */
export const MIN_BOARD_ROWS = 100;
export const MAX_BOARD_ROWS = 4000;
/** A farm plan's step count and step length, as the gate reads them. */
export const FARM_STEPS_MIN = 4;
export const FARM_STEPS_MAX = 6;
export const FARM_STEP_MIN_CHARS = 20;
export const FARM_STEP_MAX_CHARS = 600;

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365.25;

/** A farm step: the instruction, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The per-category multiple a protocol's implied value is anchored to. */
export interface CategoryMultiple {
  /** The snapshot category this multiple is for ('Uncategorized' when the snapshot names none). */
  category: string;
  /** Trading peers in this category that carry both a market cap and a TVL. */
  samples: number;
  median: number;
  p25: number;
  p75: number;
  /** 'category' when this category's own median is used, 'global' when it fell back. */
  source: 'category' | 'global';
}

/** The global fallback multiple across every trading protocol. */
export interface GlobalMultiple {
  samples: number;
  median: number;
  p25: number;
  p75: number;
}

/** The whole multiple table: the global fallback plus one row per snapshot category. */
export interface MultipleTable {
  global: GlobalMultiple;
  categories: CategoryMultiple[];
  byCategory: Map<string, CategoryMultiple>;
}

/** How one rule of the watchlist's definition leaves a protocol out. */
export interface ExclusionRule {
  id: string;
  /** The reason, in the words the board shows. */
  label: string;
  test: (p: SnapshotProtocol) => boolean;
}

/**
 * The watchlist's own exclusions, mirrored from the input README's definition of the list. Each one
 * leaves a protocol on the board, tagged, and none of them is decided by this file's author: they are
 * the rules the house applied when it drew the watchlist. `Restaking` is deliberately NOT here: the
 * watchlist itself keeps plain-restaking protocols (b14g is on it), so excluding them would not mirror
 * the definition. Only the liquid-staking family it names is excluded.
 */
export const EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: 'category-cex',
    label: 'exchange category: the venue lists its own token already',
    test: (p) => p.category === 'CEX',
  },
  {
    id: 'category-bridge',
    label: 'bridge category: a route between chains, not a protocol waiting on a launch',
    test: (p) => p.category === 'Bridge' || p.category === 'Canonical Bridge',
  },
  {
    id: 'category-liquid-staking',
    label: 'liquid staking or restaking: a receipt for a token that already trades',
    test: (p) => p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC',
  },
  {
    id: 'name-wrapped',
    label: 'the name carries wrapped, staked or staking: a receipt of an existing token',
    test: (p) => /\b(?:wrapped|staked|staking)\b/i.test(p.name),
  },
  {
    id: 'name-versioned',
    label: 'the name ends in a version marker: a pool or a fork of another protocol',
    test: (p) => /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/.test(p.name),
  },
  {
    id: 'name-exchange',
    label: "the name begins with an exchange's: a product the exchange runs, not a launch",
    test: (p) => /^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name),
  },
];

/** The multiple a protocol's value is anchored to, and where it came from. */
export interface AppliedMultiple {
  multiple: number;
  p25: number;
  p75: number;
  samples: number;
  source: 'category' | 'global';
  category: string;
}

/** One pre-token protocol's score under the model. */
export interface Scored {
  /** The value the figures imply, before the launch factor: base x growth x maturity. */
  figure: number;
  figureLow: number;
  figureHigh: number;
  implied: number;
  low: number;
  high: number;
  airdrop: number;
  base: number;
  applied: AppliedMultiple;
  growthPct: number;
  growthMult: number;
  maturityYears: number;
  maturityMult: number;
  launchLikelihood: number;
  ageDays: number | null;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  watchlist: boolean;
  launch_unlikely: boolean;
  unlikely_reasons: string[];
  /** The reasons as one sentence, or '' on a plausible launch: the line a page prints on a tagged row. */
  launch_reason: string;
  playbook: string;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  expected_airdrop_usd: number;
  percentile: number;
  /** Position among the plausible launches alone (1 is the strongest), null on a launch_unlikely row. */
  plausible_rank: number | null;
  /** The expected-value factor the model applied: 1 for a plausible launch, the launch factor on a tagged row. */
  launch_likelihood: number;
  model: {
    /** The value the figures imply, before the launch factor: base x growth x maturity. */
    figure_value_usd: number;
    base_usd: number;
    category_multiple: number;
    category_samples: number;
    multiple_source: 'category' | 'global';
    multiple_category: string;
    growth_pct: number;
    growth_multiplier: number;
    maturity_years: number;
    maturity_multiplier: number;
    age_days: number | null;
    community_allocation: number;
    eligibility_share: number;
    launch_likelihood: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row: everything the page renders for it, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  launch_unlikely: boolean;
  unlikely_reasons: string[];
  /** The reasons as one sentence, or '' on a plausible launch. */
  launch_reason: string;
  playbook: string;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  expected_airdrop_usd: number;
  percentile: number;
  plausible_rank: number | null;
  launch_likelihood: number;
  base_usd: number;
  figure_value_usd: number;
  category_multiple: number;
  category_samples: number;
  multiple_source: 'category' | 'global';
  growth_multiplier: number;
  maturity_multiplier: number;
  maturity_years: number;
  /** The same breakdown board.json carries, for a page that reads it in one place. */
  model: BoardRow['model'];
  farm_steps: string[];
}

/** An already-trading protocol: the reference table's row, with the market cap it really has. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  /** mcap_usd / tvl_usd when both are positive, else null. */
  multiple: number | null;
}

/** One exclusion rule as the dashboard states it: what it is and how many rows it tagged. */
export interface ExclusionSummary {
  id: string;
  label: string;
  count: number;
}

/** Everything the dashboard needs: the board, the reference table, the model it runs and its counts. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  model_summary: string;
  counts: {
    protocols_scanned: number;
    pre_token: number;
    already_trading: number;
    watchlist_size: number;
    watchlist_covered: number;
    board_size: number;
    plausible: number;
    launch_unlikely: number;
  };
  /** Kept for the page's headline figures: the watchlist's size, the board's size and its non-watchlist rows. */
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: GlobalMultiple;
  multiples: CategoryMultiple[];
  exclusions: ExclusionSummary[];
  assumptions: {
    community_allocation: number;
    eligibility_share: number;
    /** The launch factor applied to every launch_unlikely row on this board: 1 is no discount. */
    launch_likelihood: number;
    /** The factor's ceiling before the ordering tightening (`model.launch_likelihood_unlikely`). */
    launch_likelihood_ceiling: number;
    /** The two figures the factor is derived from: the weakest plausible launch and the largest tagged one. */
    plausible_floor_usd: number;
    largest_unlikely_figure_usd: number;
    note: string;
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all: the definition the whole radar rests on. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** The snapshot category a protocol is counted under, for the multiple table. */
export function categoryKey(category: string | null): string {
  return category === null || category.trim() === '' ? 'Uncategorized' : category;
}

/** The rules of the watchlist definition that leave this protocol out, if any. */
export function excludedBy(p: SnapshotProtocol): ExclusionRule[] {
  return EXCLUSION_RULES.filter((rule) => rule.test(p));
}

// ---------------------------------------------------------------- the multiple table

/** A sorted array's quantile, by linear interpolation between the two nearest positions. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Median, 25th and 75th percentile of an unsorted sample. */
function statsOf(sample: readonly number[]): { samples: number; median: number; p25: number; p75: number } {
  const sorted = sample.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
  };
}

/**
 * The category multiples: for every category, the median (and 25th/75th percentile) of the trading
 * protocols' market-cap-to-TVL multiples, requiring `model.min_category_samples` peers, else falling
 * back to the global median across every trading protocol. Deterministic: the snapshot's own order and
 * a total sort decide everything.
 */
export function buildMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): MultipleTable {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    const mcap = p.mcap_usd;
    if (mcap === null || !(mcap > 0) || !(p.tvl_usd > 0)) continue;
    const multiple = mcap / p.tvl_usd;
    if (!Number.isFinite(multiple) || multiple <= 0) continue;
    all.push(multiple);
    const key = categoryKey(p.category);
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [multiple]);
    else list.push(multiple);
  }
  const global = statsOf(all);
  const categories: CategoryMultiple[] = [...byCategory.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((category) => {
      const stats = statsOf(byCategory.get(category)!);
      const useOwn = stats.samples >= model.min_category_samples;
      return {
        category,
        samples: stats.samples,
        median: useOwn ? stats.median : global.median,
        p25: useOwn ? stats.p25 : global.p25,
        p75: useOwn ? stats.p75 : global.p75,
        source: useOwn ? 'category' : 'global',
      } satisfies CategoryMultiple;
    });
  return { global, categories, byCategory: new Map(categories.map((c) => [c.category, c])) };
}

/** The multiple a protocol with this category is anchored to. */
export function appliedMultiple(table: MultipleTable, category: string | null): AppliedMultiple {
  const key = categoryKey(category);
  const own = table.byCategory.get(key);
  if (own !== undefined && own.source === 'category') {
    return { multiple: own.median, p25: own.p25, p75: own.p75, samples: own.samples, source: 'category', category: key };
  }
  return {
    multiple: table.global.median,
    p25: table.global.p25,
    p75: table.global.p75,
    samples: own === undefined ? 0 : own.samples,
    source: 'global',
    category: key,
  };
}

/** A value clamped into the model's implied range and rounded to whole dollars. */
function impliedDollars(value: number, model: ModelConstants): number {
  if (!Number.isFinite(value)) return model.min_implied_usd;
  const rounded = Math.round(value);
  if (rounded < model.min_implied_usd) return model.min_implied_usd;
  if (rounded > model.max_implied_usd) return model.max_implied_usd;
  return rounded;
}

/**
 * The launch factor: the discount a protocol the watchlist leaves out carries on this snapshot.
 * `ceiling` (2%) unless that would still leave the largest tagged figure above the weakest plausible one,
 * in which case the factor is shortened so the largest tagged figure lands at `launch_band_share` of the
 * weakest plausible figure. Pure: two numbers in, one number out.
 */
export function launchFactor(weakestPlausibleFigure: number, largestUnlikelyFigure: number, model: ModelConstants = MODEL): number {
  const ceiling = model.launch_likelihood_unlikely;
  if (!(largestUnlikelyFigure > 0) || !(weakestPlausibleFigure > 0)) return ceiling;
  const band = Math.max(1, Math.floor(weakestPlausibleFigure * model.launch_band_share));
  const needed = band / largestUnlikelyFigure;
  return needed < ceiling ? needed : ceiling;
}

/**
 * The score one pre-token protocol gets under the model. Pure: snapshot fields in, numbers out.
 * `launchLikelihood` is what the row is discounted by: the caller passes the board's launch factor for a
 * tagged protocol and 1 for a plausible launch, so this function itself is name-blind and tag-blind.
 */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  table: MultipleTable,
  model: ModelConstants = MODEL,
  launchLikelihood: number = model.launch_likelihood_plausible,
): Scored {
  const applied = appliedMultiple(table, p.category);
  const age = ageDays(asOf, p.listed_at);
  const maturityYears = age === null ? model.unknown_age_years : age / DAYS_PER_YEAR;

  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;

  const cappedYears = Math.min(Math.max(maturityYears, 0), model.maturity_cap_years);
  const maturityMult = model.maturity_floor + (model.maturity_range * cappedYears) / model.maturity_cap_years;

  const tvl = Math.max(0, p.tvl_usd);
  const base = tvl * applied.multiple;
  const adjust = growthMult * maturityMult;
  const figure = impliedDollars(base * adjust, model);
  const figureLow = impliedDollars(tvl * applied.p25 * adjust, model);
  const figureHigh = impliedDollars(tvl * applied.p75 * adjust, model);

  const factor = Math.max(0, finite(launchLikelihood, model.launch_likelihood_plausible));
  const implied = impliedDollars(figure * factor, model);
  const low = impliedDollars(figureLow * factor, model);
  const high = impliedDollars(figureHigh * factor, model);
  const airdrop = Math.max(0, Math.round(implied * model.community_allocation * model.eligibility_share));

  return {
    figure,
    figureLow: Math.min(figureLow, figure),
    figureHigh: Math.max(figureHigh, figure),
    implied,
    low: Math.min(low, implied),
    high: Math.max(high, implied),
    airdrop: Math.min(airdrop, implied),
    base,
    applied,
    growthPct,
    growthMult,
    maturityYears,
    maturityMult,
    launchLikelihood: factor,
    ageDays: age,
  };
}

// ---------------------------------------------------------------- farm plans

/** Which playbook a category is farmed with. Categories are read, never protocol names. */
export function playbookFor(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('launchpad')) return 'launchpad';
  if (c.includes('dex aggregator') || (c.includes('aggregator') && !c.includes('yield'))) return 'aggregator';
  if (c.includes('dex') || c.includes('exchange')) return 'dexs';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('credit')) return 'lending';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('basis') || c.includes('options')) return 'derivatives';
  if (c.includes('yield') || c.includes('farm') || c.includes('vault') || c.includes('curator') || c.includes('allocator')) return 'yield';
  return 'other';
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A step as one string: its instruction, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > FARM_STEP_MAX_CHARS) s = `${s.slice(0, FARM_STEP_MAX_CHARS - 3)}...`;
  return s;
}

/** The first step of every plan: get funds onto the protocol's main chain and connect. */
function onboardingStep(name: string, chain: string, capital: number): FarmStep {
  return {
    text: `Get about $${capital} of USDC onto ${chain} in a wallet you control, then connect that wallet to ${name} and read its own deposit page before you send anything`,
    cost: 'about $5 for the first bridge or on-ramp fee',
    time: '10 minutes to set up',
  };
}

/** The last step of every plan: keep the record a claim would ask for. */
function trackingStep(name: string, chain: string): FarmStep {
  return {
    text: `Keep a record of every ${name} action on ${chain} with the date, the amount and the transaction hash in one file, so the history is ready if ${name} ever opens a claim`,
    cost: 'no cost beyond a text file',
    time: '5 minutes a month',
  };
}

/** One category's playbook: its middle steps, between onboarding and tracking. */
function playbookSteps(playbook: string, name: string, chain: string, capital: number, age: number | null): FarmStep[] {
  const hold = holdDaysFor(age);
  const small = Math.max(25, Math.round(capital / 2));
  switch (playbook) {
    case 'dexs':
      return [
        {
          text: `Swap $100 into and out of the pair ${name} routes best on ${chain}, at least one swap a week for four weeks`,
          cost: 'about $3 in gas and pool fees per swap',
          time: '5 minutes per swap',
        },
        {
          text: `Provide $${small} as a small two-sided liquidity position in ${name}'s deepest ${chain} pool and leave it there for at least ${hold} days`,
          cost: 'about $8 in gas to add and to withdraw',
          time: '20 minutes to set up',
        },
        {
          text: `Check ${name}'s pool page each week for the fee tier and the range before you add more, and widen your range if the price has moved out of it`,
          cost: 'about $4 in gas when you rebalance',
          time: '10 minutes a week',
        },
      ];
    case 'lending':
      return [
        {
          text: `Supply $${capital} of USDC to ${name} on ${chain} and keep it supplied rather than depositing and withdrawing`,
          cost: 'about $3 in gas to deposit',
          time: '10 minutes to set up',
        },
        {
          text: `Borrow about $${small} of ${chain}'s main asset on ${name} against that deposit and repay it within a month, keeping the loan under a third of what you supplied`,
          cost: 'about $5 in gas for the borrow and the repay',
          time: '15 minutes for the cycle',
        },
        {
          text: `Repeat the borrow-and-repay cycle twice more over the next two months on ${name}, leaving the deposit in place for at least ${hold} days between cycles`,
          cost: 'about $5 in gas each cycle',
          time: '20 minutes each cycle',
        },
        {
          text: `Watch ${name}'s health factor once a week and repay or add collateral before it nears the protocol's own limit`,
          cost: 'about $2 in gas when you top up',
          time: '5 minutes a week',
        },
      ];
    case 'bridge':
      return [
        {
          text: `Send $100 from ${chain} through ${name} to a second chain it supports and use the bridged funds there at least once`,
          cost: 'about $2 in bridge fees',
          time: '15 minutes',
        },
        {
          text: `Send $100 back from that chain to ${chain} through ${name}, so the route is used in both directions rather than one`,
          cost: 'about $2 in bridge fees',
          time: '15 minutes',
        },
        {
          text: `Move one smaller transfer through ${name} every month instead of one large transfer, and keep the same wallet on both ends`,
          cost: 'about $2 a month in bridge fees',
          time: '10 minutes a month',
        },
      ];
    case 'derivatives':
      return [
        {
          text: `Deposit $${capital} of USDC as margin on ${name} and open a long position of at most 2x on ${chain}`,
          cost: 'about $2 in trading fees',
          time: '10 minutes',
        },
        {
          text: `Open a short of the same size on ${name} so the pair is close to market-neutral before you leave it overnight`,
          cost: 'about $2 in trading fees',
          time: '5 minutes',
        },
        {
          text: `Close both sides and repeat the hedged pair once a week for four weeks on ${name}, keeping the same margin`,
          cost: 'about $4 a week in trading fees',
          time: '15 minutes a week',
        },
        {
          text: `Keep at least half of the margin on ${name} unused so a fast move does not liquidate either side, and check the funding rate you are paying`,
          cost: 'no fee to check, the funding rate is the cost',
          time: '5 minutes a week',
        },
      ];
    case 'yield':
      return [
        {
          text: `Deposit $${capital} into ${name}'s flagship vault on ${chain} and keep the receipt tokens in the same wallet`,
          cost: 'about $3 in gas to deposit',
          time: '15 minutes to set up',
        },
        {
          text: `Compound ${name}'s rewards back into the vault once a month instead of claiming and selling them`,
          cost: 'about $3 a month in gas',
          time: '10 minutes a month',
        },
        {
          text: `Read ${name}'s fee and strategy notes before adding more, and move the funds out if the strategy or the fee changes`,
          cost: 'no fee to read, about $4 in gas to exit',
          time: '15 minutes a month',
        },
      ];
    case 'aggregator':
      return [
        {
          text: `Route $100 of swaps a week through ${name} on ${chain}, splitting one larger order across two routes rather than one`,
          cost: 'about $2 in fees per route',
          time: '5 minutes per route',
        },
        {
          text: `Compare ${name}'s quote with one other router before each swap, so you can see what the route actually saves you`,
          cost: 'no fee to compare',
          time: '2 minutes per swap',
        },
        {
          text: `Keep a small balance on ${chain} so the next route through ${name} does not wait on a bridge, and swap that balance rather than moving new funds in`,
          cost: 'about $1 in fees for the transfer',
          time: '10 minutes',
        },
      ];
    case 'launchpad':
      return [
        {
          text: `Connect a wallet to ${name} on ${chain} and finish whatever checklist its sale page asks for before a sale opens`,
          cost: 'no fee to register',
          time: '15 minutes',
        },
        {
          text: `Fund that wallet with about $${capital} a week before the sale so the money is settled on ${chain} and not mid-bridge`,
          cost: 'about $3 in fees',
          time: '10 minutes',
        },
        {
          text: `Take one small allocation in a ${name} sale cycle rather than spreading across several, and read the vesting terms before you commit`,
          cost: 'about $5 in fees on top of the allocation',
          time: '20 minutes',
        },
      ];
    default:
      return [
        {
          text: `Use ${name}'s core product on ${chain} once a week with about $${capital} of funds, starting with its simplest action rather than its most complex one`,
          cost: 'about $3 a week in gas',
          time: '10 minutes a week',
        },
        {
          text: `Hold a balance of about $${small} in ${name} between sessions instead of moving funds in and out for each action`,
          cost: 'no fee beyond the first deposit',
          time: '5 minutes to set up',
        },
        {
          text: `Join ${name}'s public testnet or points surface if the protocol runs one, and use it the same way you use the product`,
          cost: 'no fee, test funds only',
          time: '20 minutes to start',
        },
      ];
  }
}

/**
 * A protocol's farm plan: onboarding first, then its category's playbook, then tracking last. Every
 * step names the protocol and its main chain, and carries an estimated cost and time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const playbook = playbookFor(p.category);
  return [
    onboardingStep(p.name, chain, capital),
    ...playbookSteps(playbook, p.name, chain, capital, age),
    trackingStep(p.name, chain),
  ];
}

// ---------------------------------------------------------------- the board

const bySlugCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One scored row before its rank is known. `tier` is 0 for a plausible launch and 1 for a tagged one. */
interface Pending {
  p: SnapshotProtocol;
  score: Scored;
  watchlist: boolean;
  reasons: string[];
  tier: number;
}

/** What the board's launch discount came out as, and what it was derived from. */
export interface LaunchSummary {
  factor: number;
  weakest_plausible_figure: number;
  largest_unlikely_figure: number;
}

/** The board and the launch discount it was built with. */
export interface BoardBuild {
  rows: BoardRow[];
  launch: LaunchSummary;
}

/**
 * The board: every pre-token protocol in the snapshot, ranked by implied value descending, ties broken
 * by TVL and then slug. Nothing is excluded from the board: the protocols the watchlist's definition
 * leaves out carry `launch_unlikely` with the reason, the launch factor keeps every one of them below
 * every plausible launch, and the page can filter them away.
 */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
  table: MultipleTable = buildMultiples(snapshot, model),
): BoardBuild {
  const watch = new Set(snapshot.watchlist);
  const staged = snapshot.protocols
    .filter(isPreToken)
    .map((p) => ({
      p,
      watchlist: watch.has(p.slug),
      reasons: excludedBy(p).map((rule) => rule.label),
    }));

  // Pass 1: what the snapshot's figures imply, with no discount, so the discount can be set from them.
  const figures = staged.map((item) => impliedValue(item.p, snapshot.as_of, table, model, model.launch_likelihood_plausible));
  let weakestPlausible = Number.POSITIVE_INFINITY;
  let largestUnlikely = 0;
  staged.forEach((item, i) => {
    const figure = figures[i]!.figure;
    if (item.reasons.length === 0) weakestPlausible = Math.min(weakestPlausible, figure);
    else largestUnlikely = Math.max(largestUnlikely, figure);
  });
  const factor = Number.isFinite(weakestPlausible)
    ? launchFactor(weakestPlausible, largestUnlikely, model)
    : model.launch_likelihood_unlikely;

  // Pass 2: the board's own value, with the launch factor on the tagged rows and 1 on the plausible ones.
  const pending: Pending[] = staged.map((item, i) => ({
    ...item,
    tier: item.reasons.length === 0 ? 0 : 1,
    score: item.reasons.length === 0 ? figures[i]! : impliedValue(item.p, snapshot.as_of, table, model, factor),
  }));

  pending.sort(
    (a, b) =>
      b.score.implied - a.score.implied ||
      a.tier - b.tier ||
      b.p.tvl_usd - a.p.tvl_usd ||
      bySlugCodeUnit(a.p.slug, b.p.slug),
  );

  const total = pending.length;
  let plausibleSeen = 0;
  const rows = pending.map((item, i) => {
    const rank = i + 1;
    const { p, score } = item;
    const plausibleRank = item.reasons.length === 0 ? (plausibleSeen += 1) : null;
    return {
      rank,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: score.ageDays,
      watchlist: item.watchlist,
      launch_unlikely: item.reasons.length > 0,
      unlikely_reasons: item.reasons,
      launch_reason: item.reasons.join('; '),
      playbook: playbookFor(p.category),
      implied_value_usd: score.implied,
      implied_low_usd: score.low,
      implied_high_usd: score.high,
      expected_airdrop_usd: score.airdrop,
      percentile: total > 1 ? Math.round((1000 * (total - rank)) / (total - 1)) / 10 : 100,
      plausible_rank: plausibleRank,
      launch_likelihood: score.launchLikelihood,
      model: {
        figure_value_usd: score.figure,
        base_usd: Math.round(score.base),
        category_multiple: round4(score.applied.multiple),
        category_samples: score.applied.samples,
        multiple_source: score.applied.source,
        multiple_category: score.applied.category,
        growth_pct: round4(score.growthPct),
        growth_multiplier: round4(score.growthMult),
        maturity_years: round4(score.maturityYears),
        maturity_multiplier: round4(score.maturityMult),
        age_days: score.ageDays,
        community_allocation: model.community_allocation,
        eligibility_share: model.eligibility_share,
        launch_likelihood: score.launchLikelihood,
      },
      farm_steps: farmSteps(p, score.ageDays).map(stepText),
    };
  });
  return {
    rows,
    launch: {
      factor,
      weakest_plausible_figure: Number.isFinite(weakestPlausible) ? weakestPlausible : 0,
      largest_unlikely_figure: largestUnlikely,
    },
  };
}

/** The already-trading protocols, for the reference table: every one, by market cap, with its real mcap. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort(
      (a, b) =>
        (b.mcap_usd ?? -1) - (a.mcap_usd ?? -1) ||
        b.tvl_usd - a.tvl_usd ||
        bySlugCodeUnit(a.slug, b.slug),
    )
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    launch_unlikely: row.launch_unlikely,
    unlikely_reasons: row.unlikely_reasons,
    playbook: row.playbook,
    implied_value_usd: row.implied_value_usd,
    implied_low_usd: row.implied_low_usd,
    implied_high_usd: row.implied_high_usd,
    expected_airdrop_usd: row.expected_airdrop_usd,
    percentile: row.percentile,
    plausible_rank: row.plausible_rank,
    launch_likelihood: row.model.launch_likelihood,
    base_usd: row.model.base_usd,
    category_multiple: row.model.category_multiple,
    category_samples: row.model.category_samples,
    multiple_source: row.model.multiple_source,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    maturity_years: row.model.maturity_years,
    model: { ...row.model },
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const table = buildMultiples(snapshot, model);
  const board = buildBoard(snapshot, model, table);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const covered = board.filter((r) => watchlist.has(r.slug)).length;
  const unlikely = board.filter((r) => r.launch_unlikely).length;
  const exclusions: ExclusionSummary[] = EXCLUSION_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    count: board.filter((r) => r.unlikely_reasons.includes(rule.label)).length,
  }));
  const preToken = board.length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    model_summary: MODEL_SUMMARY,
    counts: {
      protocols_scanned: snapshot.protocols.length,
      pre_token: preToken,
      already_trading: live.length,
      watchlist_size: snapshot.watchlist.length,
      watchlist_covered: covered,
      board_size: board.length,
      plausible: board.length - unlikely,
      launch_unlikely: unlikely,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watchlist.has(r.slug)).length,
    live_size: live.length,
    global_multiple: table.global,
    multiples: table.categories,
    exclusions,
    assumptions: {
      community_allocation: model.community_allocation,
      eligibility_share: model.eligibility_share,
      note: `Expected airdrop is a stated assumption, not a promise: it takes ${Math.round(model.community_allocation * 100)}% of the implied value as a community allocation and ${Math.round(model.eligibility_share * 100)}% of that as one wallet\u2019s share. The launch-likelihood factor is the other stated assumption: a protocol the watchlist definition leaves out is taken to be one-fiftieth as likely to issue a token of its own, so its expected launch value is ${Math.round(model.launch_likelihood_unlikely * 100)}% of what its figures imply.`,
    },
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/**
 * Why a board is not one the gate will take, or null. Every rule the gate reads is asserted here before
 * anything is written: row count, watchlist coverage, one slug per protocol, ranks 1..N, implied value
 * never rising with rank, a board that ranks nothing by value, the value caps, the bands, the airdrop
 * estimate, the farm steps' count and length, and the launch_unlikely tag's own consistency.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < MIN_BOARD_ROWS || board.length > MAX_BOARD_ROWS) {
    return `the board holds ${board.length} rows, and the gate takes ${MIN_BOARD_ROWS} to ${MAX_BOARD_ROWS}`;
  }

  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (!known.has(r.slug)) return `${r.slug} is not a protocol in the snapshot`;
    if (seen.has(r.slug)) return `${r.slug} appears on the board twice`;
    seen.add(r.slug);
    if (r.token_status !== 'pre-token') return `${r.slug} is on the board with token status ${String(r.token_status)}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > MODEL.max_implied_usd) {
      return `${r.slug} has implied value ${r.implied_value_usd}, outside 1 to ${MODEL.max_implied_usd}`;
    }
    if (!(r.implied_low_usd >= 1 && r.implied_low_usd <= r.implied_value_usd)) return `${r.slug} has a low band of ${r.implied_low_usd} against ${r.implied_value_usd}`;
    if (!(r.implied_high_usd >= r.implied_value_usd && r.implied_high_usd <= MODEL.max_implied_usd)) return `${r.slug} has a high band of ${r.implied_high_usd} against ${r.implied_value_usd}`;
    if (!(r.expected_airdrop_usd >= 0 && r.expected_airdrop_usd <= r.implied_value_usd)) return `${r.slug} has an airdrop estimate of ${r.expected_airdrop_usd} against ${r.implied_value_usd}`;
    if (r.launch_unlikely === (r.unlikely_reasons.length === 0)) {
      return `${r.slug} is tagged launch_unlikely=${String(r.launch_unlikely)} with ${r.unlikely_reasons.length} reasons`;
    }
    if (r.launch_unlikely !== (r.plausible_rank === null)) {
      return `${r.slug} has plausible_rank ${String(r.plausible_rank)} against launch_unlikely=${String(r.launch_unlikely)}`;
    }
    const likelihood = r.launch_unlikely ? MODEL.launch_likelihood_unlikely : MODEL.launch_likelihood_plausible;
    if (r.launch_likelihood !== likelihood) {
      return `${r.slug} carries launch likelihood ${r.launch_likelihood}, not the ${likelihood} its tag gives it`;
    }
    const steps = r.farm_steps;
    if (steps.length < FARM_STEPS_MIN || steps.length > FARM_STEPS_MAX) {
      return `${r.slug} has ${steps.length} farm steps, and the plan is ${FARM_STEPS_MIN} to ${FARM_STEPS_MAX}`;
    }
    for (const s of steps) {
      const text = s.trim();
      if (text.length < FARM_STEP_MIN_CHARS || text.length > FARM_STEP_MAX_CHARS) {
        return `${r.slug} has a farm step of ${text.length} characters`;
      }
      if (!text.includes(r.name)) return `${r.slug} has a farm step that does not name the protocol`;
    }
  }

  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;

  const tagged = board.filter((r) => r.watchlist && r.launch_unlikely).map((r) => r.slug);
  if (tagged.length > 0) return `the watchlist itself holds ${tagged.length} slug(s) this model tags launch_unlikely, so the exclusion rules do not mirror the watchlist: ${tagged.slice(0, 5).join(', ')}`;

  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;

  const plausible = board.filter((r) => r.plausible_rank !== null).map((r) => r.plausible_rank!).sort((a, b) => a - b);
  for (let i = 0; i < plausible.length; i++) if (plausible[i] !== i + 1) return `plausible rank ${i + 1} is ${plausible[i]}`;

  if (plausible.length > 0 && board[0]!.launch_unlikely) {
    return `rank 1 is ${board[0]!.slug}, a launch_unlikely row, while ${plausible.length} plausible launches are below it`;
  }

  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
