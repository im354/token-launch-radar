// Token Launch Radar: the scoring model.
//
// This module is a pure function of the sealed snapshot. It reads no clock, no random
// number and no network, and it never names a protocol: every figure a row carries is
// derived from that protocol's own snapshot fields. The snapshot's as_of is the only
// "today" the model knows.
//
// The shape of the calculation, in one line:
//   implied value = TVL x category median mcap/TVL x growth x maturity x launch factor
// where the category median and its quartiles come from the protocols that already
// trade, growth and maturity bend the result by the snapshot's own figures, and the
// launch factor discounts protocols the watchlist definition leaves out.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------------------
// The knobs, all in one object so the page can state them and a reader can check any row.
// ---------------------------------------------------------------------------------------

export interface ModelConstants {
  growth_clamp_low: number;
  growth_clamp_high: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_span: number;
  maturity_cap_years: number;
  unknown_age_years: number;
  min_category_peers: number;
  community_allocation: number;
  eligibility_share: number;
  implausible_ceiling: number;
  min_implied_usd: number;
  max_implied_usd: number;
}

export const MODEL: ModelConstants = {
  growth_clamp_low: -30,
  growth_clamp_high: 60,
  growth_weight: 0.5,
  maturity_floor: 0.7,
  maturity_span: 0.3,
  maturity_cap_years: 5,
  unknown_age_years: 1,
  min_category_peers: 3,
  community_allocation: 0.05,
  eligibility_share: 0.1,
  implausible_ceiling: 0.02,
  min_implied_usd: 1,
  max_implied_usd: 100000000000000,
};

export const MODEL_VERSION = 'radar-4';

export const MODEL_SUMMARY =
  'Every pre-token protocol is priced from its own TVL: the median market-cap-to-TVL multiple of the protocols already trading in the same category anchors it, seven-day growth and a capped maturity premium bend it, and a protocol the watchlist definition leaves out is tagged and discounted so it ranks below every plausible launch.';

export const MIN_BOARD_ROWS = 100;
export const MAX_BOARD_ROWS = 4000;
export const FARM_STEPS_MIN = 4;
export const FARM_STEPS_MAX = 6;
export const FARM_STEP_MIN_CHARS = 20;
export const FARM_STEP_MAX_CHARS = 600;

// ---------------------------------------------------------------------------------------
// The sets. "Pre-token" means the snapshot records neither a CoinGecko id nor a symbol;
// everything else already trades and belongs in the reference table, never the ranking.
// ---------------------------------------------------------------------------------------

export function isPreToken(p: SnapshotProtocol): boolean {
  return (p.gecko_id === null || p.gecko_id === undefined) && (p.symbol === null || p.symbol === undefined);
}

export function categoryKey(p: SnapshotProtocol): string {
  const c = p.category;
  if (typeof c !== 'string' || c.trim() === '') return 'Other';
  return c.trim();
}

// Days from the snapshot's as_of back to listed_at, never negative and never read from a
// clock. A missing or unreadable date is unknown age, which the model treats as one year.
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt || typeof listedAt !== 'string') return null;
  const a = Date.parse(asOf + 'T00:00:00Z');
  const b = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const days = Math.floor((a - b) / 86400000);
  if (!Number.isFinite(days)) return null;
  return days < 0 ? 0 : days;
}

// ---------------------------------------------------------------------------------------
// The watchlist's own exclusion logic, written out. A protocol that matches stays on the
// board with its figures intact: it is tagged unlikely and discounted, never dropped.
// ---------------------------------------------------------------------------------------

export interface ExclusionRule {
  id: string;
  label: string;
  test: (p: SnapshotProtocol) => boolean;
}

const EXCHANGE_HEADS = [
  'binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini',
];

const BRIDGE_CATEGORIES = ['Bridge', 'Canonical Bridge'];
const STAKING_CATEGORIES = ['Liquid Staking', 'Liquid Restaking', 'Restaked BTC'];
// An explicit version marker, never a bare number: "V2", "v12", "2.0". A name that merely
// ends in a digit ("Project 0") is a name, not a later version of something.
const VERSION_TAIL = /(?:^|[\s._-])(?:v\d+(?:\.\d+)*|\d+\.\d+)$/i;
const RECEIPT_WORD = /(?:^|[^a-z])(?:wrapped|staked|staking)(?:[^a-z]|$)/i;

export const EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: 'category-cex',
    label: 'CEX category: an exchange already lists a token for itself',
    test: (p) => categoryKey(p) === 'CEX',
  },
  {
    id: 'category-bridge',
    label: 'bridge category: a route between chains rather than a protocol awaiting a launch',
    test: (p) => BRIDGE_CATEGORIES.indexOf(categoryKey(p)) !== -1,
  },
  {
    id: 'category-liquid-staking',
    label: 'liquid staking or restaking: a receipt for a token that already trades',
    test: (p) => STAKING_CATEGORIES.indexOf(categoryKey(p)) !== -1,
  },
  {
    id: 'name-wrapped',
    label: 'the name carries the whole word wrapped, staked or staking: a receipt of an existing token',
    test: (p) => RECEIPT_WORD.test(String(p.name || '')),
  },
  {
    id: 'name-versioned',
    label: 'the name ends in a version marker: a pool, fork or later version, not a first launch',
    test: (p) => VERSION_TAIL.test(String(p.name || '').trim()),
  },
  {
    id: 'name-exchange',
    label: "the name begins with an exchange's name: a product the exchange runs, not its own launch",
    test: (p) => {
      const head = String(p.name || '').toLowerCase().split(/[^a-z0-9.]+/)[0];
      if (!head) return false;
      for (const ex of EXCHANGE_HEADS) if (head === ex || head.indexOf(ex) === 0) return true;
      return false;
    },
  },
];

export function excludedBy(p: SnapshotProtocol): string[] {
  const hits: string[] = [];
  for (const rule of EXCLUSION_RULES) if (rule.test(p)) hits.push(rule.label);
  return hits;
}

// ---------------------------------------------------------------------------------------
// Category multiples. Protocols that already trade say what the market pays per dollar of
// TVL for their kind of business; the median of that ratio is the anchor for the ones that
// do not trade yet. A category with fewer than three usable peers borrows the global median
// and says so, and the 25th/75th percentiles give every row its low-high band.
// ---------------------------------------------------------------------------------------

export interface Quartiles {
  samples: number;
  median: number;
  p25: number;
  p75: number;
}

export interface CategoryMultiple extends Quartiles {
  category: string;
  source: 'category' | 'global';
}

export interface MultipleTable {
  global: Quartiles;
  byCategory: Map<string, CategoryMultiple>;
  list: CategoryMultiple[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function quartilesOf(values: number[]): Quartiles {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
  };
}

const FALLBACK_GLOBAL: Quartiles = { samples: 0, median: 0.25, p25: 0.08, p75: 0.9 };

export function buildMultiples(trading: SnapshotProtocol[]): MultipleTable {
  const buckets = new Map<string, number[]>();
  const everything: number[] = [];
  for (const p of trading) {
    const tvl = p.tvl_usd;
    const mcap = p.mcap_usd;
    if (!Number.isFinite(tvl) || tvl <= 0) continue;
    if (typeof mcap !== 'number' || !Number.isFinite(mcap) || mcap <= 0) continue;
    const ratio = mcap / tvl;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const key = categoryKey(p);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(ratio);
    else buckets.set(key, [ratio]);
    everything.push(ratio);
  }

  const global = everything.length > 0 ? quartilesOf(everything) : FALLBACK_GLOBAL;
  const list: CategoryMultiple[] = [];
  const byCategory = new Map<string, CategoryMultiple>();
  for (const category of Array.from(buckets.keys()).sort()) {
    const own = quartilesOf(buckets.get(category) as number[]);
    const thin = own.samples < MODEL.min_category_peers;
    const entry: CategoryMultiple = {
      category,
      samples: own.samples,
      median: thin ? global.median : own.median,
      p25: thin ? global.p25 : own.p25,
      p75: thin ? global.p75 : own.p75,
      source: thin ? 'global' : 'category',
    };
    list.push(entry);
    byCategory.set(category, entry);
  }
  return { global, byCategory, list };
}

export interface AppliedMultiple extends Quartiles {
  category: string;
  source: 'category' | 'global';
}

export function appliedMultiple(table: MultipleTable, category: string): AppliedMultiple {
  const found = table.byCategory.get(category);
  if (found) {
    return {
      category,
      samples: found.samples,
      median: found.median,
      p25: found.p25,
      p75: found.p75,
      source: found.source,
    };
  }
  return {
    category,
    samples: 0,
    median: table.global.median,
    p25: table.global.p25,
    p75: table.global.p75,
    source: 'global',
  };
}

// ---------------------------------------------------------------------------------------
// Growth and maturity. Growth bends the value by the last seven days of TVL movement at
// half weight, capped so a single volatile week cannot carry a row. Maturity rewards a
// protocol that has run longer with no token, capped at five years.
// ---------------------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function growthMultiplier(change7d: number | null): number {
  if (typeof change7d !== 'number' || !Number.isFinite(change7d)) return 1;
  const bounded = clamp(change7d, MODEL.growth_clamp_low, MODEL.growth_clamp_high);
  return 1 + (bounded / 100) * MODEL.growth_weight;
}

export function maturityYears(days: number | null): number {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return MODEL.unknown_age_years;
  return days / 365.25;
}

export function maturityMultiplier(years: number): number {
  const capped = Math.min(Math.max(years, 0), MODEL.maturity_cap_years);
  return MODEL.maturity_floor + (MODEL.maturity_span * capped) / MODEL.maturity_cap_years;
}

export function impliedValue(base: number, growth: number, maturity: number): number {
  const rounded = Math.round(base * growth * maturity);
  if (!Number.isFinite(rounded)) return MODEL.min_implied_usd;
  return clamp(rounded, MODEL.min_implied_usd, MODEL.max_implied_usd);
}

// ---------------------------------------------------------------------------------------
// Farm playbooks. One per kind of business; each plan opens with the same kind of
// onboarding step and closes with the same kind of record-keeping step, and the middle
// steps differ by what the protocol actually does.
// ---------------------------------------------------------------------------------------

export type PlaybookId =
  | 'dexs'
  | 'lending'
  | 'bridge'
  | 'derivatives'
  | 'yield'
  | 'aggregator'
  | 'launchpad'
  | 'default';

interface StepContext {
  name: string;
  chain: string;
  size: string;
  half: string;
  small: string;
  gas: string;
}

const PLAYBOOKS: Record<PlaybookId, (c: StepContext) => string[]> = {
  dexs: (c) => [
    `Swap ${c.size} into ${c.chain}'s main quote asset on ${c.name} in two or three ordinary trades rather than one, keeping the output in the same wallet: ${c.gas} in gas for the set, about 10 minutes.`,
    `Add a small two-sided position of ${c.small} to the ${c.name} pool you traded against, narrow enough to withdraw the same day: ${c.gas} in gas to open, about 20 minutes to size and review.`,
    `Rebalance the ${c.name} range whenever price leaves it, and leave it rebalanced once a week: ${c.gas} in gas per rebalance, about 8 minutes each time.`,
    `Claim the fees ${c.name} has accrued and record the claim, so the wallet shows trading, providing and claiming instead of one deposit: ${c.gas} in gas, about 5 minutes.`,
  ],
  lending: (c) => [
    `Supply ${c.size} of ${c.chain}'s main stablecoin to ${c.name} and leave it supplied: ${c.gas} in gas, about 15 minutes to set up and 5 minutes a week to check the position.`,
    `Borrow a conservative ${c.small} against that supply on ${c.name}, keeping the health factor well above the platform's warning line for a full week: ${c.gas} in gas, about 10 minutes.`,
    `Repay the ${c.name} borrow in full and borrow again the following week, so the wallet shows a repayment cycle rather than one deposit: ${c.gas} in gas per cycle, about 10 minutes each time.`,
    `Write down the supply and borrow rates ${c.name} pays each time you cycle, so you can tell later whether the position earned its risk: no gas, about 5 minutes a week.`,
  ],
  bridge: (c) => [
    `Bridge ${c.size} onto ${c.chain} with ${c.name} itself rather than a third-party route, and verify the arrival before moving on: ${c.gas} in gas for the transfer, about 10 minutes.`,
    `Bridge ${c.half} back out through ${c.name} to the chain you came from, so the route shows use in both directions rather than a one-way hop: ${c.gas} in gas, about 10 minutes.`,
    `Send one more transfer through ${c.name} a week later with a different asset, because a bridge is judged on the pairs it carries and not only on volume: ${c.gas} in gas, about 10 minutes.`,
    `Keep the ${c.name} transfer id, the date and the amount for every route you use, so a later snapshot can be matched to your own record: no gas, about 5 minutes.`,
  ],
  derivatives: (c) => [
    `Open a small ${c.small} position on ${c.name} with a stop already set, then close it inside the same session: ${c.gas} in gas plus the venue's own fee, about 15 minutes.`,
    `Open a hedged pair the following week, one long and one short of similar size on ${c.name}, so the wallet is not simply directional: ${c.gas} in gas plus fees, about 20 minutes.`,
    `Repeat one small hedged trade every week on ${c.name} and close it before the week ends, which is the pattern an activity snapshot can see: ${c.gas} in gas per round trip, about 15 minutes each time.`,
    `Record the entry, the exit and the funding ${c.name} charged on ${c.chain} for every round trip, so a reader sees a habit rather than a single trade: no gas, about 5 minutes a week.`,
  ],
  yield: (c) => [
    `Deposit ${c.size} into the flagship vault ${c.name} runs on ${c.chain}, and note the share price you entered at: ${c.gas} in gas, about 10 minutes to set up.`,
    `Leave the ${c.name} position compounding instead of withdrawing the yield, and re-read the vault's fee and cap before adding more: no gas, about 10 minutes once.`,
    `Add a second, smaller deposit of ${c.small} to ${c.name} once a week, so the vault sees a growing position rather than a single entry: ${c.gas} in gas per deposit, about 8 minutes each time.`,
    `Compare the ${c.name} share price with your entry price every week and write the difference down with the date: no gas, about 5 minutes each time.`,
  ],
  aggregator: (c) => [
    `Route ${c.size} of swaps through ${c.name} on ${c.chain} in three separate trades across two days rather than one large order: ${c.gas} in gas for the set, about 15 minutes.`,
    `Compare the price ${c.name} quotes on ${c.chain} with a single venue for the same pair, and keep a note of the difference: no gas, about 10 minutes once.`,
    `Use ${c.name} again the following week for an ordinary trade you would have made anyway, so the usage is routine rather than a test: ${c.gas} in gas, about 5 minutes each time.`,
    `Record each ${c.name} route with the pair, the amount and the date, so the record shows a pattern across weeks: no gas, about 5 minutes a week.`,
  ],
  launchpad: (c) => [
    `Read ${c.name}'s current sale terms on ${c.chain} and note the minimum, the vesting and the close date before committing anything: no gas, about 15 minutes.`,
    `Take part in one ${c.name} sale cycle with ${c.small}, no more than you would be content to hold through the full vesting period: ${c.gas} in gas plus the sale's own fee, about 20 minutes.`,
    `Check the ${c.name} allocation and claim schedule a week after the sale closes, and claim only what has vested: ${c.gas} in gas, about 10 minutes.`,
    `Write down what the ${c.name} sale cost against what it returned, with the dates, so the next sale is a decision rather than a guess: no gas, about 10 minutes.`,
  ],
  default: (c) => [
    `Use ${c.name}'s core product on ${c.chain} once with ${c.size}, following its own documentation for the first transaction rather than a third-party guide: ${c.gas} in gas, about 15 minutes.`,
    `Keep a working balance inside ${c.name} instead of moving it in and out, because a balance that stays is what a snapshot of usage can see: no extra gas, about 5 minutes.`,
    `Return to ${c.name} once a week and use the same product again, so the address shows repeat use rather than a single visit: ${c.gas} in gas per visit, about 10 minutes each time.`,
    `Check whether ${c.name} runs a public testnet or a points page on ${c.chain} and join it if it does, because those surfaces usually count earlier than a token does: no gas, about 15 minutes once.`,
  ],
};

// Categories come from the snapshot, so this maps a category's words to a playbook and is
// never a roster of protocol names.
export function playbookFor(category: string): PlaybookId {
  const c = category.toLowerCase();
  if (c.indexOf('dex') !== -1 || c.indexOf('swap') !== -1) return 'dexs';
  if (c.indexOf('lend') !== -1 || c.indexOf('cdp') !== -1 || c.indexOf('credit') !== -1) return 'lending';
  if (c.indexOf('bridge') !== -1) return 'bridge';
  if (c.indexOf('derivative') !== -1 || c.indexOf('perp') !== -1 || c.indexOf('option') !== -1) return 'derivatives';
  if (c.indexOf('yield') !== -1 || c.indexOf('vault') !== -1 || c.indexOf('farm') !== -1) return 'yield';
  if (c.indexOf('aggregator') !== -1) return 'aggregator';
  if (c.indexOf('launchpad') !== -1) return 'launchpad';
  return 'default';
}

function dollars(n: number): string {
  const rounded = Math.max(25, Math.round(n / 25) * 25);
  return '$' + rounded.toLocaleString('en-US');
}

function gasEstimate(chain: string): string {
  if (/^(Solana|Sui|Aptos|Near|TON|Stacks|Starknet|Hyperliquid L1)$/i.test(chain)) return 'about $1';
  if (/^(Base|Arbitrum|Optimism|Polygon|Scroll|zkSync Era|Linea|Blast|Manta|Morph|X Layer|Sonic|Sei|Celo|World Chain|Unichain|Berachain)$/i.test(chain)) return 'about $2';
  return 'about $5';
}

function stepText(text: string): string {
  let out = String(text).replace(/\s+/g, ' ').trim();
  if (out.length > FARM_STEP_MAX_CHARS) out = out.slice(0, FARM_STEP_MAX_CHARS - 1).trimEnd() + '.';
  return out;
}

export function farmPlan(p: SnapshotProtocol, category: string): string[] {
  const chain = p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  const tvl = Number.isFinite(p.tvl_usd) ? p.tvl_usd : 0;
  const budget = Math.max(50, Math.min(500, tvl * 0.0000015));
  const ctx: StepContext = {
    name: p.name,
    chain,
    size: dollars(budget),
    half: dollars(budget / 2),
    small: dollars(Math.max(25, budget / 4)),
    gas: gasEstimate(chain),
  };

  const onboarding =
    `Move ${ctx.size} of ${chain}'s main stablecoin into a wallet you control, then open ${p.name} in that wallet and read its own deposit or trade page before signing anything: ${ctx.gas} in gas for the setup, about 15 minutes end to end.`;

  const tracking =
    `Keep a dated log of every ${p.name} action on ${chain}: the amount, the transaction hash and the day, re-read once a week so a snapshot can be matched to your own record: no gas, about 5 minutes a week.`;

  const middle = PLAYBOOKS[playbookFor(category)](ctx);
  const steps = [onboarding, ...middle, tracking].map(stepText);
  while (steps.length > FARM_STEPS_MAX) steps.splice(steps.length - 2, 1);
  return steps;
}

// ---------------------------------------------------------------------------------------
// Scoring and ranking.
// ---------------------------------------------------------------------------------------

export interface Scored {
  protocol: SnapshotProtocol;
  category: string;
  multiple: AppliedMultiple;
  base: number;
  growth: number;
  years: number;
  maturity: number;
  figure: number;
  reasons: string[];
  unlikely: boolean;
}

export interface LaunchSummary {
  factor: number;
  ceiling: number;
  plausible_floor_usd: number;
  largest_unlikely_figure_usd: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  age_years: number;
  watchlist: boolean;
  launch_unlikely: boolean;
  launch_reason: string;
  playbook: PlaybookId;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  expected_airdrop_usd: number;
  category_multiple: number;
  category_samples: number;
  multiple_source: 'category' | 'global';
  base_value_usd: number;
  figure_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  launch_likelihood: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface ExclusionSummary {
  id: string;
  label: string;
  count: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model_summary: string;
  model: ModelConstants;
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
  protocols_scanned: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: Quartiles;
  multiples: CategoryMultiple[];
  exclusions: ExclusionSummary[];
  assumptions: {
    community_allocation: number;
    eligibility_share: number;
    launch_factor: number;
    launch_factor_ceiling: number;
    plausible_floor_usd: number;
    largest_unlikely_figure_usd: number;
    note: string;
  };
  rows: BoardRow[];
  live: LiveRow[];
  watchlist: string[];
}

// The launch factor: one number for the whole board, at most the implausible ceiling and
// shorter whenever that ceiling would still let a tagged protocol outrank the weakest
// plausible launch. Because every tagged row is multiplied by it, the tagged group sits
// below every plausible launch by value, not merely by sort order.
export function launchFactor(scored: Scored[]): LaunchSummary {
  let plausibleFloor = Infinity;
  let largestUnlikely = 0;
  let anyPlausible = false;
  for (const s of scored) {
    if (s.unlikely) {
      if (s.figure > largestUnlikely) largestUnlikely = s.figure;
    } else {
      anyPlausible = true;
      if (s.figure < plausibleFloor) plausibleFloor = s.figure;
    }
  }
  const ceiling = MODEL.implausible_ceiling;
  const floor = Number.isFinite(plausibleFloor) ? plausibleFloor : 0;
  if (!anyPlausible || floor <= 0 || largestUnlikely <= 0) {
    return {
      factor: ceiling,
      ceiling,
      plausible_floor_usd: floor,
      largest_unlikely_figure_usd: largestUnlikely,
    };
  }
  const safe = (0.9 * floor) / largestUnlikely;
  return {
    factor: Math.min(ceiling, safe),
    ceiling,
    plausible_floor_usd: floor,
    largest_unlikely_figure_usd: largestUnlikely,
  };
}

function scoreAll(snapshot: Snapshot, table: MultipleTable): Scored[] {
  const out: Scored[] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const category = categoryKey(p);
    const multiple = appliedMultiple(table, category);
    const tvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? p.tvl_usd : 0;
    const base = tvl * multiple.median;
    const growth = growthMultiplier(p.change_7d);
    const days = ageDays(snapshot.as_of, p.listed_at);
    const years = maturityYears(days);
    const maturity = maturityMultiplier(years);
    const figure = impliedValue(base, growth, maturity);
    const reasons = excludedBy(p);
    out.push({
      protocol: p,
      category,
      multiple,
      base,
      growth,
      years,
      maturity,
      figure,
      reasons,
      unlikely: reasons.length > 0,
    });
  }
  return out;
}

function totalOrder(a: Scored, b: Scored): number {
  if (b.figure !== a.figure) return b.figure - a.figure;
  if (b.protocol.tvl_usd !== a.protocol.tvl_usd) return b.protocol.tvl_usd - a.protocol.tvl_usd;
  return a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0;
}

export function buildRadar(snapshot: Snapshot): RadarData {
  const trading = snapshot.protocols.filter((p) => !isPreToken(p));
  const preToken = snapshot.protocols.filter(isPreToken);
  const table = buildMultiples(trading);
  const watch = new Set(snapshot.watchlist);

  const scored = scoreAll(snapshot, table);
  const launch = launchFactor(scored);

  const plausible = scored.filter((s) => !s.unlikely).sort(totalOrder);
  const unlikely = scored.filter((s) => s.unlikely).sort(totalOrder);
  const ordered = plausible.concat(unlikely);

  const rows: BoardRow[] = ordered.map((s, index) => {
    const p = s.protocol;
    const factor = s.unlikely ? launch.factor : 1;
    const tvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? p.tvl_usd : 0;
    const at = (multiple: number): number =>
      clamp(Math.round(tvl * multiple * s.growth * s.maturity * factor), MODEL.min_implied_usd, MODEL.max_implied_usd);
    const implied = clamp(Math.round(s.figure * factor), MODEL.min_implied_usd, MODEL.max_implied_usd);
    const years = s.years;
    return {
      rank: index + 1,
      slug: p.slug,
      name: p.name,
      category: s.category,
      chains: p.chains.slice(),
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      age_days: ageDays(snapshot.as_of, p.listed_at),
      age_years: years,
      watchlist: watch.has(p.slug),
      launch_unlikely: s.unlikely,
      launch_reason: s.reasons.join('; '),
      playbook: playbookFor(s.category),
      implied_value_usd: implied,
      implied_low_usd: at(s.multiple.p25),
      implied_high_usd: at(s.multiple.p75),
      expected_airdrop_usd: Math.max(
        1,
        Math.round(implied * MODEL.community_allocation * MODEL.eligibility_share),
      ),
      category_multiple: s.multiple.median,
      category_samples: s.multiple.samples,
      multiple_source: s.multiple.source,
      base_value_usd: Math.round(s.base),
      figure_value_usd: s.figure,
      growth_multiplier: s.growth,
      maturity_multiplier: s.maturity,
      launch_likelihood: factor,
      farm_steps: farmPlan(p, s.category),
    };
  });

  // The band is built from the same growth and maturity as the row, with the category's
  // own quartile multiple in place of the median; for a tagged row the launch factor
  // applies to the band as it does to the point estimate.

  const counts = new Map<string, number>();
  for (const s of scored) {
    for (const rule of EXCLUSION_RULES) {
      if (rule.test(s.protocol)) counts.set(rule.id, (counts.get(rule.id) || 0) + 1);
    }
  }
  const exclusions: ExclusionSummary[] = EXCLUSION_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    count: counts.get(rule.id) || 0,
  }));

  let covered = 0;
  for (const slug of watch) if (preToken.some((p) => p.slug === slug)) covered++;

  const live: LiveRow[] = trading
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: categoryKey(p),
      chains: p.chains.slice(),
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }))
    .sort((a, b) => {
      const am = a.mcap_usd === null ? -1 : a.mcap_usd;
      const bm = b.mcap_usd === null ? -1 : b.mcap_usd;
      if (bm !== am) return bm - am;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });

  const floor = typeof snapshot.floor_usd === 'number' && Number.isFinite(snapshot.floor_usd) ? snapshot.floor_usd : 0;
  const belowFloor = preToken.filter((p) => p.tvl_usd < floor).length;
  const factorPct = (launch.factor * 100).toFixed(4);

  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: floor,
    model_version: MODEL_VERSION,
    model_summary: MODEL_SUMMARY,
    model: MODEL,
    counts: {
      protocols_scanned: snapshot.protocols.length,
      pre_token: preToken.length,
      already_trading: trading.length,
      watchlist_size: snapshot.watchlist.length,
      watchlist_covered: covered,
      board_size: rows.length,
      plausible: plausible.length,
      launch_unlikely: unlikely.length,
    },
    protocols_scanned: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    early_size: belowFloor,
    live_size: live.length,
    global_multiple: table.global,
    multiples: table.list,
    exclusions,
    assumptions: {
      community_allocation: MODEL.community_allocation,
      eligibility_share: MODEL.eligibility_share,
      launch_factor: launch.factor,
      launch_factor_ceiling: launch.ceiling,
      plausible_floor_usd: Math.round(launch.plausible_floor_usd),
      largest_unlikely_figure_usd: launch.largest_unlikely_figure_usd,
      note:
        'Expected airdrop takes ' +
        Math.round(MODEL.community_allocation * 100) +
        '% of the implied value as a community allocation and ' +
        Math.round(MODEL.eligibility_share * 100) +
        '% of that as one active wallet\'s share. It is a stated assumption, not a promise. The launch factor is the other stated assumption: a protocol the watchlist definition leaves out keeps ' +
        factorPct +
        '% of the value its figures imply, at most ' +
        Math.round(launch.ceiling * 100) +
        '%, and the ceiling tightens whenever the full ceiling would let a tagged protocol outrank the weakest plausible launch.',
    },
    rows,
    live,
    watchlist: snapshot.watchlist.slice(),
  };
}

// ---------------------------------------------------------------------------------------
// The gate, in code. main.ts runs this before anything is written, so a broken board fails
// locally instead of at submission.
// ---------------------------------------------------------------------------------------

export function boardIssue(radar: RadarData): string | null {
  const rows = radar.rows;
  if (rows.length < MIN_BOARD_ROWS) return 'the board holds ' + rows.length + ' rows, under the ' + MIN_BOARD_ROWS + ' the gate requires';
  if (rows.length > MAX_BOARD_ROWS) return 'the board holds ' + rows.length + ' rows, over the ' + MAX_BOARD_ROWS + ' the gate allows';

  const slugs = new Set<string>();
  let previous = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (typeof r.slug !== 'string' || r.slug === '' || /\s/.test(r.slug)) return 'row ' + (i + 1) + ' has no usable slug';
    if (slugs.has(r.slug)) return 'the slug ' + r.slug + ' appears twice';
    slugs.add(r.slug);
    if (typeof r.name !== 'string' || r.name.trim() === '') return 'the row ' + r.slug + ' has no name';
    if (r.rank !== i + 1) return 'the rank of ' + r.slug + ' is ' + r.rank + ', not ' + (i + 1);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > MODEL.max_implied_usd) {
      return 'the implied value of ' + r.slug + ' is not a whole number of dollars inside the cap';
    }
    if (r.implied_value_usd > previous) return 'the implied value rises at ' + r.slug + ' (rank ' + r.rank + ')';
    previous = r.implied_value_usd;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < FARM_STEPS_MIN || r.farm_steps.length > FARM_STEPS_MAX) {
      return 'the plan for ' + r.slug + ' has ' + (Array.isArray(r.farm_steps) ? r.farm_steps.length : 'no') + ' steps';
    }
    for (const step of r.farm_steps) {
      if (typeof step !== 'string') return 'a step for ' + r.slug + ' is not a string';
      const trimmed = step.trim();
      if (trimmed.length < FARM_STEP_MIN_CHARS || trimmed.length > FARM_STEP_MAX_CHARS) {
        return 'a step for ' + r.slug + ' is ' + trimmed.length + ' characters';
      }
    }
  }

  if (radar.rows.length > 1 && new Set(radar.rows.map((r) => r.implied_value_usd)).size === 1) {
    return 'every row carries the same implied value, so the board ranks nothing';
  }

  for (const slug of radar.watchlist) {
    if (!slugs.has(slug)) return 'the watchlist slug ' + slug + ' is not on the board';
  }

  const firstPlausible = radar.rows.findIndex((r) => !r.launch_unlikely);
  const lastPlausible = radar.rows.map((r) => !r.launch_unlikely).lastIndexOf(true);
  const tagged = radar.rows.filter((r) => r.launch_unlikely);
  if (firstPlausible !== -1 && tagged.some((r) => r.rank - 1 < lastPlausible)) {
    return 'a tagged row ranks above a plausible launch';
  }
  const factors = new Set(tagged.map((r) => r.launch_likelihood));
  if (factors.size > 1) return 'the tagged rows do not share one launch factor';
  for (const f of factors) {
    if (!(f > 0) || f > MODEL.implausible_ceiling) return 'the launch factor ' + f + ' is outside its range';
  }
  for (const r of tagged) {
    if (Math.abs(Math.round(r.figure_value_usd * r.launch_likelihood) - r.implied_value_usd) > 1) {
      return 'the implied value of ' + r.slug + ' is not its figure times the launch factor';
    }
  }
  return null;
}

// The browser's data file. JSON.stringify is deterministic for the shapes written here,
// and the model reads no clock, so two runs over one snapshot write the same bytes.
export function dataScript(radar: RadarData): string {
  return '// Written by main.ts from the sealed snapshot. Generated: do not edit by hand.\nwindow.RADAR=' + JSON.stringify(radar) + ';\n';
}

// ---------------------------------------------------------------------------------------
// Reading the snapshot.
// ---------------------------------------------------------------------------------------

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SnapshotError('the snapshot is not valid JSON: ' + (err as Error).message);
  }
  const s = raw as Partial<Snapshot>;
  if (!s || typeof s !== 'object') throw new SnapshotError('the snapshot is not an object');
  if (typeof s.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.as_of)) {
    throw new SnapshotError('the snapshot has no usable as_of date (YYYY-MM-DD)');
  }
  if (!Array.isArray(s.protocols)) throw new SnapshotError('the snapshot has no protocols array');
  if (!Array.isArray(s.watchlist)) throw new SnapshotError('the snapshot has no watchlist array');
  const seen = new Set<string>();
  const protocols: SnapshotProtocol[] = [];
  for (const item of s.protocols as SnapshotProtocol[]) {
    if (!item || typeof item !== 'object') throw new SnapshotError('a protocol entry is not an object');
    if (typeof item.slug !== 'string' || item.slug === '') throw new SnapshotError('a protocol entry has no slug');
    if (seen.has(item.slug)) throw new SnapshotError('the snapshot repeats the slug ' + item.slug);
    seen.add(item.slug);
    protocols.push({
      slug: item.slug,
      name: typeof item.name === 'string' ? item.name : item.slug,
      category: typeof item.category === 'string' ? item.category : null,
      chains: Array.isArray(item.chains) ? item.chains.filter((c) => typeof c === 'string') : [],
      tvl_usd: typeof item.tvl_usd === 'number' && Number.isFinite(item.tvl_usd) ? item.tvl_usd : 0,
      change_7d: typeof item.change_7d === 'number' && Number.isFinite(item.change_7d) ? item.change_7d : null,
      mcap_usd: typeof item.mcap_usd === 'number' && Number.isFinite(item.mcap_usd) ? item.mcap_usd : null,
      listed_at: typeof item.listed_at === 'string' ? item.listed_at : null,
      gecko_id: typeof item.gecko_id === 'string' ? item.gecko_id : null,
      symbol: typeof item.symbol === 'string' ? item.symbol : null,
    });
  }
  return {
    as_of: s.as_of,
    source: typeof s.source === 'string' ? s.source : 'a sealed snapshot',
    floor_usd: typeof s.floor_usd === 'number' && Number.isFinite(s.floor_usd) ? s.floor_usd : 0,
    protocols,
    watchlist: (s.watchlist as string[]).filter((w) => typeof w === 'string'),
  };
}
