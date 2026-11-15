// The radar's model. One sealed snapshot in, one ranked board out.
//
// TWO SETS, NEVER MIXED. A protocol is PRE-TOKEN when the snapshot records no token for it at all: no
// coingecko id and no ticker. Every other protocol in the snapshot ALREADY TRADES: it keeps its real
// market cap and goes to the reference table, and it is never scored, ranked or counted on the board.
//
// COVERAGE. The board ranks every pre-token protocol the snapshot holds (342 on this input), not the
// watchlist. The watchlist's own slugs are flagged as members. The protocols the watchlist's published
// definition leaves out stay on the board and are tagged launch_unlikely with the rule that caught them,
// because a bridge or a staked receipt is still a protocol a reader may want to find; it simply is not a
// launch. The rules below are a transcription of that definition, category by category and pattern by
// pattern. Nothing is decided by a protocol's individual name: no slug or name appears in this file.
//
// IMPLIED VALUE is anchored to what trading peers are worth per dollar of TVL. From the protocols that
// already trade, per category:
//
//     peer multiple      = mcap_usd / tvl_usd                     (only where both are positive)
//     category multiple  = the median of the category's multiples (needs >= 3 peers, else the global median)
//     band               = the 25th and 75th percentile of the same multiples
//
// Then, for one pre-token protocol:
//
//     base      = tvl_usd x category multiple
//     growth    = 1 + clamp(change_7d, -30, 60) / 100 x 0.5      (no seven-day change recorded: 1)
//     maturity  = 0.7 + 0.3 x min(years since listed_at, 5) / 5  (no listing date: 1 year)
//     figure    = clamp(round(base x growth x maturity), 1, 100T)     what the figures alone imply
//     launch    = 1 for a plausible launch, the launch factor below for a tagged one
//     implied   = clamp(round(figure x launch), 1, 100T)
//     low/high  = the same arithmetic run on the 25th/75th percentile multiple
//     airdrop   = implied x 0.05 assumed community allocation x 0.10 assumed wallet share
//
// THE LAUNCH FACTOR is how "ranked below the plausible launches" is made true rather than wished for.
// The gate refuses a board whose implied value rises as rank ascends, so the ordering has to come out of
// the value itself. A tagged protocol's value is therefore discounted by one factor f for the whole
// board:
//
//     f = min(2%, 0.9 x the weakest plausible launch's figure / the largest tagged figure)
//
// The second term does the guaranteeing: a bridge with billions of TVL can out-imply a small plausible
// launch even at 2%, so f is shortened on a given snapshot until every tagged row lands at or below 90%
// of the weakest plausible figure. One factor for the whole board keeps the tagged rows in their own
// order among themselves, and the arithmetic is still a pure function of the snapshot. The factor that
// was applied is written into the data under `assumptions`, and the page states it, so a reader can see
// the discount rather than having to trust it.
//
// THE AIRDROP FIGURE IS A STATED ASSUMPTION, NEVER A PROMISE. It is the implied value times a 5% assumed
// community allocation times a 10% assumed share for one farming wallet, and the page says so in those
// words beside the number.
//
// RANK is the implied value descending, ties broken by TVL descending and then by slug ascending. Every
// plausible launch ranks above every tagged protocol, which the factor above makes true by construction.
// A tagged row also carries `plausible_rank`: where it would sit among the plausible launches alone.
//
// Everything in this file is a pure function of the snapshot. No clock is read (the snapshot's as_of is
// today), nothing is drawn at random, nothing is fetched, and no protocol is singled out by name. The
// same bytes in give the same board out.

/** One protocol as the sealed snapshot carries it: exactly the ten fields. */
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

/** The model's constants. The dashboard prints these, so they are data, not buried literals. */
export interface ModelConstants {
  /** How much of the seven-day change is believed: 0.5 reads the trend at half weight. */
  growth_weight: number;
  /** The seven-day change is clamped into [growth_floor, growth_cap] per cent before weighting. */
  growth_floor: number;
  growth_cap: number;
  /** maturity = maturity_floor + maturity_range x min(years, maturity_cap_years) / maturity_cap_years. */
  maturity_floor: number;
  maturity_range: number;
  maturity_cap_years: number;
  /** The age assumed when the snapshot records no listing date. */
  unknown_age_years: number;
  /** Trading peers a category needs before its own multiple is used instead of the global one. */
  min_category_samples: number;
  /** Share of the implied value assumed to reach a community allocation. */
  community_allocation: number;
  /** Share of that allocation assumed to reach one farming wallet. */
  eligibility_share: number;
  /** Implied value is clamped into [min_implied_usd, max_implied_usd]. */
  min_implied_usd: number;
  max_implied_usd: number;
  /** What a plausible launch keeps of its figure: all of it. */
  launch_likelihood_plausible: number;
  /** The ceiling on what a tagged protocol keeps: 2%, and less when 2% would break the ordering. */
  launch_likelihood_unlikely: number;
  /** The share of the weakest plausible figure the largest tagged figure is discounted under: 0.9. */
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

/** What the page names the model in its chip. */
export const MODEL_VERSION = 'radar-3';

/** One sentence the page prints under the title. */
export const MODEL_SUMMARY =
  'Implied value = TVL x the median market-cap-to-TVL multiple of the protocols already trading in the same category, bent by seven-day growth and by how long the protocol has run with no token; a protocol the watchlist definition leaves out is discounted and ranks below every plausible launch.';

/** The gate's row limits: a board outside them is refused before it is written. */
export const MIN_BOARD_ROWS = 100;
export const MAX_BOARD_ROWS = 4000;
/** A farm plan's step count and per-step length, as the gate reads them. */
export const FARM_STEPS_MIN = 4;
export const FARM_STEPS_MAX = 6;
export const FARM_STEP_MIN_CHARS = 20;
export const FARM_STEP_MAX_CHARS = 600;

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365.25;

/** One instruction in a farm plan: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The multiple one category's pre-token protocols are priced against. */
export interface CategoryMultiple {
  category: string;
  /** Trading peers in this category carrying both a market cap and a TVL. */
  samples: number;
  median: number;
  p25: number;
  p75: number;
  /** 'category' when this category's own median is in use, 'global' when it fell back. */
  source: 'category' | 'global';
}

/** The fallback multiple across every trading protocol in the snapshot. */
export interface GlobalMultiple {
  samples: number;
  median: number;
  p25: number;
  p75: number;
}

/** The global fallback plus one row per category the snapshot names. */
export interface MultipleTable {
  global: GlobalMultiple;
  categories: CategoryMultiple[];
  byCategory: Map<string, CategoryMultiple>;
}

/** One rule of the watchlist's published definition. */
export interface ExclusionRule {
  id: string;
  /** The reason, in the words the board prints. */
  label: string;
  test: (p: SnapshotProtocol) => boolean;
}

/**
 * The watchlist's own exclusions, transcribed from the definition in the input README. A rule here does
 * not remove a protocol: it tags it, and the row stays on the board below the plausible launches.
 *
 * The README names four families: the exchange category, the bridge categories, the liquid-staking and
 * restaking categories, and three name shapes (a wrapped/staked/staking receipt, a name ending in a
 * version marker, a name opening with an exchange's). Plain `Restaking` is deliberately absent: the
 * watchlist itself carries a plain-restaking protocol, so excluding the category would not mirror the
 * list. Only the liquid-staking family the definition names is transcribed.
 */
export const EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: 'category-cex',
    label: 'exchange category: the venue already lists a token for itself',
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
    label: 'the name carries wrapped, staked or staking: a receipt of a token that already exists',
    test: (p) => /\b(?:wrapped|staked|staking)\b/i.test(p.name),
  },
  {
    id: 'name-versioned',
    label: 'the name ends in a version marker: a pool or a fork of another protocol, not a protocol',
    test: (p) => /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/.test(p.name),
  },
  {
    id: 'name-exchange',
    label: "the name opens with an exchange's: a product the exchange runs, not a launch of its own",
    test: (p) => /^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name),
  },
];

/** The multiple a row is priced against, and where it came from. */
export interface AppliedMultiple {
  multiple: number;
  p25: number;
  p75: number;
  samples: number;
  source: 'category' | 'global';
  category: string;
}

/** One pre-token protocol under the model, before the launch factor is known. */
export interface Scored {
  figure: number;
  figureLow: number;
  figureHigh: number;
  base: number;
  applied: AppliedMultiple;
  growthPct: number;
  growthMult: number;
  maturityYears: number;
  maturityMult: number;
  ageDays: number | null;
}

/** A row of board.json: what the gate reads and what the page shows. */
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
  /** The reasons as one sentence, or '' on a plausible launch. */
  launch_reason: string;
  playbook: string;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  expected_airdrop_usd: number;
  percentile: number;
  /** Where the row would sit among the plausible launches alone; null when it is one. */
  plausible_rank: number | null;
  /** 1 on a plausible launch, the launch factor on a tagged row. */
  launch_likelihood: number;
  model: {
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

/** The page's compact view of one row: the same breakdown, flattened, plus its farm plan. */
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
  model: BoardRow['model'];
  farm_steps: string[];
}

/** One already-trading protocol: the reference table's row, with the market cap it really has. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** One exclusion rule as the page states it, with how many rows it tagged. */
export interface ExclusionSummary {
  id: string;
  label: string;
  count: number;
}

/** Everything the page needs: the board, the reference table, the model, and its counts. */
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
  watchlist_size: number;
  board_size: number;
  /** Board rows outside the watchlist: the page's "below the floor" style figure. */
  early_size: number;
  live_size: number;
  protocols_scanned: number;
  global_multiple: GlobalMultiple;
  multiples: CategoryMultiple[];
  exclusions: ExclusionSummary[];
  assumptions: {
    community_allocation: number;
    eligibility_share: number;
    launch_likelihood: number;
    launch_likelihood_ceiling: number;
    plausible_floor_usd: number;
    largest_unlikely_figure_usd: number;
    note: string;
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot handed to this model is not one it can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ------------------------------------------------------------------ reading the snapshot

/** A finite number, else the fallback. */
function numeric(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A string, else the fallback. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A string or null, and nothing else. */
function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A finite number or null. */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read one protocol, or throw naming what is wrong with it. */
function readProtocol(raw: unknown, index: number): SnapshotProtocol {
  if (raw === null || typeof raw !== 'object') throw new SnapshotError(`protocol ${index} is not an object`);
  const p = raw as Record<string, unknown>;
  const slug = nullableText(p.slug);
  if (slug === null) throw new SnapshotError(`protocol ${index} carries no slug`);
  const chains = Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [];
  return {
    slug: slug.trim(),
    name: text(p.name, slug).trim(),
    category: nullableText(p.category),
    chains,
    tvl_usd: Math.max(0, Math.round(numeric(p.tvl_usd, 0))),
    change_7d: nullableNumber(p.change_7d),
    mcap_usd: nullableNumber(p.mcap_usd),
    listed_at: nullableText(p.listed_at),
    gecko_id: nullableText(p.gecko_id),
    symbol: nullableText(p.symbol),
  };
}

/** Read and check the whole snapshot document. */
export function parseSnapshot(json: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new SnapshotError(`the snapshot is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object') throw new SnapshotError('the snapshot is not a JSON object');
  const doc = raw as Record<string, unknown>;
  const asOf = nullableText(doc.as_of);
  if (asOf === null) throw new SnapshotError('the snapshot records no as_of date');
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('the snapshot records no protocols array');
  const protocols = doc.protocols.map((p, i) => readProtocol(p, i));
  const watchlist = Array.isArray(doc.watchlist)
    ? doc.watchlist.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
    : [];
  return {
    as_of: asOf.slice(0, 10),
    source: text(doc.source, 'unknown'),
    floor_usd: numeric(doc.floor_usd, 0),
    protocols,
    watchlist,
  };
}

// ------------------------------------------------------------------ small pure helpers

/** Whole days from `listedAt` to `asOf`, floored at zero; null when either date is absent or unreadable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const today = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  const then = Date.parse(`${listedAt.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(today) || !Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((today - then) / DAY_MS));
}

/** True when the protocol records no token at all: the one definition the radar rests on. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** The key a protocol is counted under in the multiple table. */
export function categoryKey(category: string | null): string {
  return category === null || category.trim() === '' ? 'Uncategorized' : category;
}

/** Which rules of the watchlist definition catch this protocol. */
export function excludedBy(p: SnapshotProtocol): ExclusionRule[] {
  return EXCLUSION_RULES.filter((rule) => rule.test(p));
}

/** `value` held inside [low, high]. */
function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** A dollar amount the gate will take: a positive whole number inside the model's caps. */
function dollars(value: number, model: ModelConstants): number {
  if (!Number.isFinite(value)) return model.min_implied_usd;
  return Math.round(clamp(value, model.min_implied_usd, model.max_implied_usd));
}

// ------------------------------------------------------------------ the multiple table

/** The q-quantile of an ascending array, interpolated between the two nearest positions. */
function quantile(ascending: readonly number[], q: number): number {
  if (ascending.length === 0) return Number.NaN;
  if (ascending.length === 1) return ascending[0] as number;
  const pos = (ascending.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  const a = ascending[low] as number;
  const b = ascending[high] as number;
  return a + (b - a) * (pos - low);
}

/** The median and the quartiles of a sample. */
function distribution(sample: readonly number[]): { samples: number; median: number; p25: number; p75: number } {
  const ascending = [...sample].sort((a, b) => a - b);
  return {
    samples: ascending.length,
    median: quantile(ascending, 0.5),
    p25: quantile(ascending, 0.25),
    p75: quantile(ascending, 0.75),
  };
}

/** The market-cap-to-TVL multiple of a protocol that already trades, when both figures are usable. */
function peerMultiple(p: SnapshotProtocol): number | null {
  if (p.mcap_usd === null || p.mcap_usd <= 0) return null;
  if (p.tvl_usd <= 0) return null;
  const multiple = p.mcap_usd / p.tvl_usd;
  return Number.isFinite(multiple) && multiple > 0 ? multiple : null;
}

/**
 * Build the multiple table from the protocols that already trade. A category with at least
 * `min_category_samples` peers keeps its own median and quartiles; every other category, and every
 * protocol the snapshot files under no category, is priced against the global distribution.
 */
export function buildMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): MultipleTable {
  const byCategorySample = new Map<string, number[]>();
  const globalSample: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    const multiple = peerMultiple(p);
    if (multiple === null) continue;
    globalSample.push(multiple);
    const key = categoryKey(p.category);
    const bucket = byCategorySample.get(key);
    if (bucket === undefined) byCategorySample.set(key, [multiple]);
    else bucket.push(multiple);
  }
  const global = distribution(globalSample);
  const categories: CategoryMultiple[] = [];
  for (const key of [...byCategorySample.keys()].sort()) {
    const stats = distribution(byCategorySample.get(key) as number[]);
    const own = stats.samples >= model.min_category_samples;
    categories.push({
      category: key,
      samples: stats.samples,
      median: own ? stats.median : global.median,
      p25: own ? stats.p25 : global.p25,
      p75: own ? stats.p75 : global.p75,
      source: own ? 'category' : 'global',
    });
  }
  const byCategory = new Map(categories.map((c) => [c.category, c] as const));
  return { global, categories, byCategory };
}

/** The multiple a protocol is priced against: its category's when that category has enough peers. */
export function appliedMultiple(table: MultipleTable, category: string | null, model: ModelConstants = MODEL): AppliedMultiple {
  const key = categoryKey(category);
  const own = table.byCategory.get(key);
  if (own !== undefined && own.source === 'category' && own.samples >= model.min_category_samples) {
    return { multiple: own.median, p25: own.p25, p75: own.p75, samples: own.samples, source: 'category', category: key };
  }
  return {
    multiple: table.global.median,
    p25: table.global.p25,
    p75: table.global.p75,
    samples: own === undefined ? table.global.samples : own.samples,
    source: 'global',
    category: key,
  };
}

// ------------------------------------------------------------------ scoring one protocol

/**
 * Score one pre-token protocol: the figure its own fields imply, before any launch discount. The band
 * runs the identical arithmetic on the 25th and 75th percentile multiples.
 */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  table: MultipleTable,
  model: ModelConstants = MODEL,
): Scored {
  const days = ageDays(asOf, p.listed_at);
  const years = days === null ? model.unknown_age_years : days / DAYS_PER_YEAR;
  const maturityMult =
    model.maturity_floor + (model.maturity_range * Math.min(years, model.maturity_cap_years)) / model.maturity_cap_years;
  const growthPct = p.change_7d === null ? 0 : clamp(p.change_7d, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const applied = appliedMultiple(table, p.category, model);
  const shape = growthMult * maturityMult;
  return {
    figure: dollars(p.tvl_usd * applied.multiple * shape, model),
    figureLow: dollars(p.tvl_usd * applied.p25 * shape, model),
    figureHigh: dollars(p.tvl_usd * applied.p75 * shape, model),
    base: Math.round(p.tvl_usd * applied.multiple),
    applied,
    growthPct,
    growthMult,
    maturityYears: years,
    maturityMult,
    ageDays: days,
  };
}

/**
 * The discount a tagged protocol's figure is multiplied by. One number for the whole board: at most the
 * ceiling, and short enough that the largest tagged figure lands under `launch_band_share` of the
 * weakest plausible one, which is what keeps every tagged row below every plausible launch while
 * preserving their order among themselves.
 */
export function launchFactor(
  weakestPlausibleFigure: number | null,
  largestTaggedFigure: number | null,
  model: ModelConstants = MODEL,
): number {
  const ceiling = model.launch_likelihood_unlikely;
  if (largestTaggedFigure === null || largestTaggedFigure <= 0) return ceiling;
  if (weakestPlausibleFigure === null || weakestPlausibleFigure <= 0) return ceiling;
  const ordered = (model.launch_band_share * weakestPlausibleFigure) / largestTaggedFigure;
  return Math.max(0, Math.min(ceiling, ordered));
}

// ------------------------------------------------------------------ farm plans

/** The playbook a category follows: the shape of the work, not the name of the protocol. */
export function playbookFor(category: string | null): string {
  switch (categoryKey(category)) {
    case 'Dexs':
      return 'dexs';
    case 'Lending':
    case 'CDP':
    case 'CDP Manager':
    case 'Uncollateralized Lending':
    case 'Collateral Markets':
      return 'lending';
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
      return 'bridge';
    case 'Derivatives':
    case 'Basis Trading':
    case 'Options Vault':
    case 'Interest Rate Derivatives':
      return 'derivatives';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Leveraged Farming':
    case 'Farm':
      return 'yield';
    case 'Aggregator':
    case 'Liquidity Manager':
      return 'aggregator';
    case 'Launchpad':
      return 'launchpad';
    default:
      return 'default';
  }
}

/** The main chain a plan is written around: the first the snapshot lists, or a neutral phrase. */
function mainChain(p: SnapshotProtocol): string {
  const first = p.chains.find((c) => c.trim() !== '');
  return first === undefined ? 'its main chain' : first;
}

/**
 * The notional position a plan is sized for, from the protocol's own TVL: a larger protocol is worth a
 * larger test position, because the point of the position is to be visible beside a real book.
 */
function positionSize(p: SnapshotProtocol): number {
  const billion = 1_000_000_000;
  if (p.tvl_usd >= 2 * billion) return 500;
  if (p.tvl_usd >= 500_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** What a transaction on a chain is assumed to cost at this position size. */
function gasEstimate(position: number): string {
  const dollars = Math.max(1, Math.round(position * 0.012));
  return `about $${dollars} in gas`;
}

/** How long a position is held before the plan tells the reader to check it again. */
function holdDays(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 500_000_000) return 14;
  if (p.tvl_usd >= 100_000_000) return 10;
  return 7;
}

/** Step one of every plan: the funds have to reach the chain the protocol runs on. */
function onboarding(p: SnapshotProtocol, chain: string, position: number): FarmStep {
  const name = p.name;
  return {
    text: `Get about $${position} of the chain's main stablecoin onto ${chain} in a wallet you control, then connect that wallet to ${name} and read its own deposit page before you send anything: ${gasEstimate(position)} for the two transactions, about 15 minutes end to end.`,
    cost: `~$${Math.max(1, Math.round(position * 0.012)) + 3}`,
    time: '15 minutes',
  };
}

/** The last step of every plan: the record is the point, because a launch snapshot pays the wallets it can see. */
function tracking(p: SnapshotProtocol, chain: string): FarmStep {
  return {
    text: `Keep a dated log of every ${p.name} transaction you made on ${chain}, with the amount, the date and the transaction hash, and re-read it once a week so a snapshot can be matched to your own record: no gas, about 5 minutes a week.`,
    cost: 'none',
    time: '5 minutes a week',
  };
}

/** The four to six steps of a plan, chosen by the playbook the category follows. */
export function playbookSteps(
  playbook: string,
  p: SnapshotProtocol,
  chain: string,
  position: number,
  hold: number,
): FarmStep[] {
  const name = p.name;
  const size = `$${position}`;
  const holdText = hold === 14 ? 'two weeks' : hold === 10 ? 'ten days' : 'a week';
  const gas = gasEstimate(position);
  switch (playbook) {
    case 'dexs':
      return [
        {
          text: `Swap ${size} into the ${chain} quote asset on ${name} in two or three ordinary trades rather than one, and keep the output in the same wallet: ${gas} for the set, 10 minutes in all.`,
          cost: `$${Math.max(1, Math.round(position * 0.012)) + 4}`,
          time: '10 minutes',
        },
        {
          text: `Add a small two-sided position of about $${Math.round(position * 0.5)} to the ${name} pool you traded against on ${chain}, narrow enough that you can withdraw it the same day: ${gas} to open, 20 minutes to size and review.`,
          cost: `$${Math.max(1, Math.round(position * 0.012)) + 2}`,
          time: '20 minutes',
        },
        {
          text: `Rebalance the ${name} position on ${chain} whenever it drifts past the edge of your range, and leave it rebalanced once every ${holdText}: ${gas} per rebalance, about 8 minutes each time.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: `8 minutes every ${holdText}`,
        },
        {
          text: `Claim whatever fees ${name} has accrued on ${chain} and record the claim, so the wallet shows trading, providing and claiming rather than a single deposit: ${gas}, 5 minutes.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '5 minutes',
        },
      ];
    case 'lending':
      return [
        {
          text: `Supply ${size} of the ${chain} stablecoin to ${name} and leave it supplied, because a standing balance is what a points programme can see: ${gas}, about 10 minutes to set up.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '10 minutes',
        },
        {
          text: `Borrow about 25% of what you supplied against the same collateral on ${name} and hold the borrowed asset rather than spending it, so the health factor stays comfortable: ${gas}, 10 minutes.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '10 minutes',
        },
        {
          text: `Repay and re-borrow the ${name} position once every ${holdText} on ${chain} so the account shows repeat borrowing rather than one loan: ${gas} per cycle, about 8 minutes each time.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: `8 minutes every ${holdText}`,
        },
        {
          text: `Watch the ${name} health factor after each borrow on ${chain} and repay early if it drops near the liquidation line: no cost, 5 minutes on every check.`,
          cost: 'none',
          time: '5 minutes per check',
        },
      ];
    case 'bridge':
      return [
        {
          text: `Route a real transfer of about $${Math.round(position * 0.4)} across ${name} to ${chain} rather than only opening the page, and keep the receiving address in the same wallet: ${gas} plus the fee the route charges, 15 minutes.`,
          cost: `$${Math.max(2, Math.round(position * 0.02))}`,
          time: '15 minutes',
        },
        {
          text: `Send a second transfer back the other way through ${name} once the first lands, because a route used in both directions is worth more than a one-way test: ${gas} plus the fee, 15 minutes.`,
          cost: `$${Math.max(2, Math.round(position * 0.02))}`,
          time: '15 minutes',
        },
        {
          text: `Repeat the round trip on ${name} once every ${holdText} with a small amount, about $${Math.round(position * 0.1)}, so the route sees steady volume from your address: ${gas} per trip, 10 minutes each time.`,
          cost: `$${Math.max(2, Math.round(position * 0.02))}`,
          time: `10 minutes every ${holdText}`,
        },
        {
          text: `Note which ${chain} assets ${name} moves most cheaply and use that pair for the repeat trips, so the fee does not eat the test: no cost, 10 minutes once.`,
          cost: 'none',
          time: '10 minutes',
        },
      ];
    case 'derivatives':
      return [
        {
          text: `Open a small ${name} position of about $${Math.round(position * 0.3)} on ${chain} with a stop set before you enter, and size it so a total loss is acceptable: ${gas} plus the trading fee, 15 minutes.`,
          cost: `$${Math.max(2, Math.round(position * 0.015))}`,
          time: '15 minutes',
        },
        {
          text: `Hedge that ${name} position against the same asset on a second venue, or with the opposite side of the same market, so the pair is roughly delta-neutral: ${gas}, 10 minutes.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '10 minutes',
        },
        {
          text: `Close and reopen the ${name} pair once every ${holdText} on ${chain} instead of leaving one trade open, so the account shows weekly activity rather than a single entry: ${gas} per cycle, 10 minutes each time.`,
          cost: `$${Math.max(2, Math.round(position * 0.015))}`,
          time: `10 minutes every ${holdText}`,
        },
        {
          text: `Check the ${name} funding rate before each reopen on ${chain}, and skip the week when funding runs against the hedge: no cost, 5 minutes per check.`,
          cost: 'none',
          time: '5 minutes per check',
        },
      ];
    case 'yield':
      return [
        {
          text: `Deposit ${size} into the flagship vault ${name} runs on ${chain} and note the share price you entered at: ${gas}, about 10 minutes to set up.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '10 minutes',
        },
        {
          text: `Leave the ${name} position compounding instead of withdrawing the yield, and re-read the vault's fee and cap before you add to it: no gas, 10 minutes once.`,
          cost: 'none',
          time: '10 minutes',
        },
        {
          text: `Add a second, smaller deposit of about $${Math.round(position * 0.25)} to ${name} on ${chain} once every ${holdText}, so the vault sees a growing position rather than one entry: ${gas} per deposit, 8 minutes each time.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: `8 minutes every ${holdText}`,
        },
        {
          text: `Compare the ${name} share price against your entry price every ${holdText} and write the difference down with the date: no gas, 5 minutes each time.`,
          cost: 'none',
          time: `5 minutes every ${holdText}`,
        },
      ];
    case 'aggregator':
      return [
        {
          text: `Route your first swap of about ${size} through ${name} on ${chain} instead of the venue behind it, and compare the quoted output against a direct route: ${gas} plus the routing fee, 10 minutes.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '10 minutes',
        },
        {
          text: `Make every later swap you would have made anyway go through ${name}, so the router sees steady volume from your address rather than one test: ${gas} per swap, about 5 minutes each.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '5 minutes per swap',
        },
        {
          text: `Use the ${name} route for one cross-venue swap on ${chain} once every ${holdText}, and keep the output in a wallet you control: ${gas}, 8 minutes each time.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: `8 minutes every ${holdText}`,
        },
        {
          text: `Record the slippage ${name} quoted against the best direct route each time, because the difference is the only thing that makes routing worth measuring: no cost, 5 minutes per entry.`,
          cost: 'none',
          time: '5 minutes per entry',
        },
      ];
    case 'launchpad':
      return [
        {
          text: `Read the current sale terms on ${name} before committing anything: the ${chain} raise size, the vesting schedule and the wallet cap all decide whether a position is worth taking, and reading costs nothing but 20 minutes.`,
          cost: 'none',
          time: '20 minutes',
        },
        {
          text: `Commit the smallest allowed ticket, about ${size}, to one ${name} sale on ${chain} rather than several, so a single cycle is fully completed: ${gas} plus the ticket, 15 minutes.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '15 minutes',
        },
        {
          text: `Follow that ${name} sale through to its claim or refund on ${chain} and claim on the first day the claim opens: ${gas}, 10 minutes when the claim window opens.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '10 minutes',
        },
        {
          text: `Write down the ${name} sale's allocation, price and vesting dates as soon as the result is published, so the position can be tracked after the cycle closes: no gas, 10 minutes.`,
          cost: 'none',
          time: '10 minutes',
        },
      ];
    default:
      return [
        {
          text: `Use ${name}'s core product on ${chain} with about ${size} once, following its own documentation for the first transaction rather than a third-party guide: ${gas}, about 15 minutes.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: '15 minutes',
        },
        {
          text: `Hold a working balance inside ${name} on ${chain} instead of moving it in and out, because a balance that stays is what a snapshot of usage can see: no extra gas, 5 minutes.`,
          cost: 'none',
          time: '5 minutes',
        },
        {
          text: `Come back to ${name} once every ${holdText} and use the same product again, so the address shows repeat use rather than a single visit: ${gas} per visit, 10 minutes each time.`,
          cost: `$${Math.max(1, Math.round(position * 0.012))}`,
          time: `10 minutes every ${holdText}`,
        },
        {
          text: `Check whether ${name} runs a public testnet or a points page on ${chain} and join it if it does, because those surfaces usually count earlier than any token does: no gas, 15 minutes once.`,
          cost: 'none',
          time: '15 minutes',
        },
      ];
  }
}

/** The whole plan for one protocol: onboarding first, the playbook in the middle, tracking last. */
export function farmSteps(p: SnapshotProtocol, playbook: string): FarmStep[] {
  const chain = mainChain(p);
  const position = positionSize(p);
  const hold = holdDays(p);
  return [onboarding(p, chain, position), ...playbookSteps(playbook, p, chain, position, hold), tracking(p, chain)];
}

/** A step as the one string the gate reads and the page prints. */
export function stepText(step: FarmStep): string {
  const trimmed = step.text.trim();
  return trimmed.length <= FARM_STEP_MAX_CHARS ? trimmed : `${trimmed.slice(0, FARM_STEP_MAX_CHARS - 1)}…`;
}

// ------------------------------------------------------------------ building the board

/** Everything the build produces. */
export interface BoardBuild {
  board: BoardRow[];
  radar: RadarData;
  launchLikelihood: number;
  plausible: number;
  launchUnlikely: number;
}

/** The reference table's rows: every protocol that already trades, with the market cap it really has. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: peerMultiple(p),
    }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** The page's compact view of a finished board row. */
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
    launch_reason: row.launch_reason,
    playbook: row.playbook,
    implied_value_usd: row.implied_value_usd,
    implied_low_usd: row.implied_low_usd,
    implied_high_usd: row.implied_high_usd,
    expected_airdrop_usd: row.expected_airdrop_usd,
    percentile: row.percentile,
    plausible_rank: row.plausible_rank,
    launch_likelihood: row.launch_likelihood,
    base_usd: row.model.base_usd,
    figure_value_usd: row.model.figure_value_usd,
    category_multiple: row.model.category_multiple,
    category_samples: row.model.category_samples,
    multiple_source: row.model.multiple_source,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    maturity_years: row.model.maturity_years,
    model: row.model,
    farm_steps: row.farm_steps,
  };
}

/** A pending row: scored and tagged, before the launch factor and the ranks are settled. */
interface Pending {
  protocol: SnapshotProtocol;
  scored: Scored;
  reasons: string[];
  playbook: string;
}

/** Highest value first, then the largest protocol, then the slug: a total order, so the sort is stable by construction. */
function byValue(a: Pending, b: Pending): number {
  if (b.scored.figure !== a.scored.figure) return b.scored.figure - a.scored.figure;
  if (b.protocol.tvl_usd !== a.protocol.tvl_usd) return b.protocol.tvl_usd - a.protocol.tvl_usd;
  return a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0;
}

/**
 * Build the ranked board and the page's dataset from one snapshot. Every pre-token protocol is scored,
 * the tagged ones are discounted so they cannot outrank a plausible launch, and the whole thing is
 * ranked by implied value with TVL and slug as tie-breakers.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardBuild {
  const table = buildMultiples(snapshot, model);
  const watchlist = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter((p) => isPreToken(p));

  const plausible: Pending[] = [];
  const tagged: Pending[] = [];
  for (const protocol of preToken) {
    const scored = scoreProtocol(protocol, snapshot.as_of, table, model);
    const rules = excludedBy(protocol);
    const pending: Pending = {
      protocol,
      scored,
      reasons: rules.map((r) => r.label),
      playbook: playbookFor(protocol.category),
    };
    if (rules.length === 0) plausible.push(pending);
    else tagged.push(pending);
  }

  plausible.sort(byValue);
  tagged.sort(byValue);

  const weakest = plausible.length === 0 ? null : (plausible[plausible.length - 1] as Pending).scored.figure;
  const largestTagged = tagged.length === 0 ? null : (tagged[0] as Pending).scored.figure;
  const factor = launchFactor(weakest, largestTagged, model);

  const total = plausible.length + tagged.length;
  const board: BoardRow[] = [];
  const place = (pending: Pending, launch: number, plausibleRank: number | null): void => {
    const rank = board.length + 1;
    const p = pending.protocol;
    const s = pending.scored;
    const implied = dollars(s.figure * launch, model);
    const low = dollars(Math.min(s.figureLow, s.figure) * launch, model);
    const high = dollars(Math.max(s.figureHigh, s.figure) * launch, model);
    board.push({
      rank,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      age_days: s.ageDays,
      watchlist: watchlist.has(p.slug),
      launch_unlikely: pending.reasons.length > 0,
      unlikely_reasons: [...pending.reasons],
      launch_reason: pending.reasons.join('; '),
      playbook: pending.playbook,
      implied_value_usd: implied,
      implied_low_usd: Math.min(low, implied),
      implied_high_usd: Math.max(high, implied),
      expected_airdrop_usd: dollars(implied * model.community_allocation * model.eligibility_share, model),
      percentile: Math.round(((total - rank + 1) / total) * 1000) / 10,
      plausible_rank: plausibleRank,
      launch_likelihood: launch,
      model: {
        figure_value_usd: s.figure,
        base_usd: s.base,
        category_multiple: s.applied.multiple,
        category_samples: s.applied.samples,
        multiple_source: s.applied.source,
        multiple_category: s.applied.category,
        growth_pct: s.growthPct,
        growth_multiplier: s.growthMult,
        maturity_years: s.maturityYears,
        maturity_multiplier: s.maturityMult,
        age_days: s.ageDays,
        community_allocation: model.community_allocation,
        eligibility_share: model.eligibility_share,
        launch_likelihood: launch,
      },
      farm_steps: farmSteps(p, pending.playbook).map(stepText),
    });
  };

  plausible.forEach((pending, index) => place(pending, model.launch_likelihood_plausible, index + 1));
  for (const pending of tagged) place(pending, factor, null);

  const exclusionCounts = new Map<string, number>();
  for (const pending of tagged) {
    for (const rule of EXCLUSION_RULES) {
      if (rule.test(pending.protocol)) exclusionCounts.set(rule.id, (exclusionCounts.get(rule.id) ?? 0) + 1);
    }
  }
  const exclusions: ExclusionSummary[] = EXCLUSION_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    count: exclusionCounts.get(rule.id) ?? 0,
  })).filter((e) => e.count > 0);

  const watchlistCovered = snapshot.watchlist.filter((slug) => board.some((r) => r.slug === slug)).length;
  const live = liveRows(snapshot);
  const percent = (v: number) => `${(v * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`;
  const note =
    `Expected airdrop is a stated assumption, not a promise: it takes ${percent(model.community_allocation)} of the implied value as a community allocation and ${percent(model.eligibility_share)} of that as one wallet's share. ` +
    `The launch factor is the other stated assumption: a protocol the watchlist definition leaves out keeps ${percent(factor)} of the value its figures imply, at most ${percent(model.launch_likelihood_unlikely)}, and the ceiling is shortened whenever the full ceiling would let a tagged protocol outrank the weakest plausible launch.`;

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    model_summary: MODEL_SUMMARY,
    counts: {
      protocols_scanned: snapshot.protocols.length,
      pre_token: preToken.length,
      already_trading: snapshot.protocols.length - preToken.length,
      watchlist_size: snapshot.watchlist.length,
      watchlist_covered: watchlistCovered,
      board_size: board.length,
      plausible: plausible.length,
      launch_unlikely: tagged.length,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    protocols_scanned: snapshot.protocols.length,
    global_multiple: table.global,
    multiples: table.categories,
    exclusions,
    assumptions: {
      community_allocation: model.community_allocation,
      eligibility_share: model.eligibility_share,
      launch_likelihood: factor,
      launch_likelihood_ceiling: model.launch_likelihood_unlikely,
      plausible_floor_usd: weakest ?? 0,
      largest_unlikely_figure_usd: largestTagged ?? 0,
      note,
    },
    rows: board.map(radarRow),
    live,
  };

  return { board, radar, launchLikelihood: factor, plausible: plausible.length, launchUnlikely: tagged.length };
}

/** Both halves of the build, which is what main.ts asks for. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, radar } = buildBoard(snapshot, model);
  return { board, radar };
}

// ------------------------------------------------------------------ self-validation

/**
 * Check a finished board against the gate's limits before a byte is written. Returns the first thing
 * wrong as one sentence, or null when the board is one the gate takes. This is the model's own audit,
 * not the gate: it repeats every limit the rules publish so a bad board fails here, loudly, instead of
 * failing silently at grading time.
 */
export function boardIssue(board: readonly BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < MIN_BOARD_ROWS || board.length > MAX_BOARD_ROWS) {
    return `${board.length} rows: the gate takes ${MIN_BOARD_ROWS} to ${MAX_BOARD_ROWS}`;
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  let plausibleSeen = 0;
  let taggedSeen = 0;
  for (let i = 0; i < board.length; i += 1) {
    const row = board[i] as BoardRow;
    const at = `row ${i + 1} (${row.slug})`;
    if (row.rank !== i + 1) return `${at}: rank ${row.rank} where ${i + 1} belongs`;
    if (!known.has(row.slug)) return `${at}: not a slug the snapshot holds`;
    if (seen.has(row.slug)) return `${at}: appears twice`;
    seen.add(row.slug);
    if (row.name.trim() === '') return `${at}: no name`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1) return `${at}: implied value ${row.implied_value_usd} is not a positive whole number`;
    if (row.implied_value_usd > MODEL.max_implied_usd) return `${at}: implied value past the cap`;
    if (row.implied_value_usd > previous) return `${at}: implied value rises as rank ascends`;
    previous = row.implied_value_usd;
    if (row.implied_low_usd > row.implied_value_usd || row.implied_high_usd < row.implied_value_usd) {
      return `${at}: the band does not straddle the implied value`;
    }
    if (row.launch_unlikely) {
      taggedSeen += 1;
      if (row.launch_reason.trim() === '') return `${at}: tagged with no reason`;
      if (row.plausible_rank !== null) return `${at}: a tagged row carries a plausible rank`;
    } else {
      if (taggedSeen > 0) return `${at}: a plausible launch sits below a tagged row`;
      plausibleSeen += 1;
      if (row.plausible_rank === null) return `${at}: a plausible launch carries no plausible rank`;
    }
    if (!Number.isFinite(row.launch_likelihood) || row.launch_likelihood <= 0 || row.launch_likelihood > 1) {
      return `${at}: launch likelihood ${row.launch_likelihood} is not inside (0, 1]`;
    }
    if (row.farm_steps.length < FARM_STEPS_MIN || row.farm_steps.length > FARM_STEPS_MAX) {
      return `${at}: ${row.farm_steps.length} farm steps, the gate takes ${FARM_STEPS_MIN} to ${FARM_STEPS_MAX}`;
    }
    for (const [index, step] of row.farm_steps.entries()) {
      const length = step.trim().length;
      if (length < FARM_STEP_MIN_CHARS || length > FARM_STEP_MAX_CHARS) {
        return `${at}: step ${index + 1} is ${length} characters, the gate takes ${FARM_STEP_MIN_CHARS} to ${FARM_STEP_MAX_CHARS}`;
      }
    }
  }
  const missing = snapshot.watchlist.filter((slug) => !seen.has(slug));
  if (missing.length > 0) return `the watchlist is not covered: ${missing.slice(0, 5).join(', ')} missing`;
  const values = new Set(board.map((r) => r.implied_value_usd));
  if (board.length > 1 && values.size === 1) return 'every row carries the same implied value';
  return null;
}

/** The dashboard's dataset as the one script it loads, with a comment saying where it came from. */
export function dataScript(radar: RadarData): string {
  return `// Written by main.ts from the sealed snapshot. Generated: do not edit by hand.\nwindow.RADAR=${JSON.stringify(radar)};\n`;
}
