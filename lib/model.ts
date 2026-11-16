// The radar's model: one pure function of the sealed snapshot, standard library only.
//
// Nothing in this file reads a clock, a random number or the network, and no protocol is
// named anywhere in it. Every figure a row carries is derived from the snapshot's own
// fields, so the same snapshot always produces the same board. The snapshot's as_of is
// the only "today" this module knows about.

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
// The model's knobs, all in one place so the page can state them and a reader can check
// any number a row shows.
// ---------------------------------------------------------------------------------------

export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_cap_years: number;
  unknown_age_years: number;
  min_category_samples: number;
  community_allocation: number;
  eligibility_share: number;
  min_implied_usd: number;
  max_implied_usd: number;
  launch_likelihood_plausible: number;
  launch_likelihood_unlikely: number;
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
  max_implied_usd: 100000000000000,
  launch_likelihood_plausible: 1,
  launch_likelihood_unlikely: 0.02,
};

export const MODEL_VERSION = 'radar-3';

export const MODEL_SUMMARY =
  'Implied value = TVL x the median market-cap-to-TVL multiple of the protocols already trading in the same category, bent by seven-day growth and by how long the protocol has run with no token; a protocol the watchlist definition leaves out is discounted and ranks below every plausible launch.';

export const MIN_BOARD_ROWS = 100;
export const MAX_BOARD_ROWS = 4000;
export const FARM_STEPS_MIN = 4;
export const FARM_STEPS_MAX = 6;
export const FARM_STEP_MIN_CHARS = 20;
export const FARM_STEP_MAX_CHARS = 600;

export type FarmStep = string;

// ---------------------------------------------------------------------------------------
// Sets. A protocol with neither a market-cap id nor a ticker has never traded, which is
// the whole of what "pre-token" means here. Everything else already has a price.
// ---------------------------------------------------------------------------------------

export function isPreToken(p: SnapshotProtocol): boolean {
  return (p.gecko_id === null || p.gecko_id === undefined) && (p.symbol === null || p.symbol === undefined);
}

export function categoryKey(p: SnapshotProtocol): string {
  const c = p.category;
  if (typeof c !== 'string' || c.trim() === '') return 'Uncategorised';
  return c.trim();
}

// Days between the snapshot's as_of and a listed_at date, never negative, never from the
// clock. A missing or unreadable date is unknown age, not zero.
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
// The watchlist's own exclusion logic, written out. A protocol a rule matches stays on
// the board and keeps its figures; it is flagged and discounted, never dropped.
// ---------------------------------------------------------------------------------------

export interface ExclusionRule {
  id: string;
  label: string;
  test: (p: SnapshotProtocol) => boolean;
}

const EXCHANGE_NAMES = [
  'binance', 'coinbase', 'okx', 'bybit', 'bitget', 'kucoin', 'gate', 'htx',
  'huobi', 'crypto.com', 'kraken', 'bitfinex', 'mexc', 'upbit', 'bithumb',
];

const STAKING_CATEGORIES = ['Liquid Staking', 'Liquid Restaking', 'Restaking'];
const BRIDGE_CATEGORIES = ['Bridge', 'Canonical Bridge', 'Cross Chain Bridge'];
const VERSION_MARKER = /(?:^|[\s._-])v\d{1,2}$/i;
const STAKING_WORD = /(?:^|[^a-z])(wrapped|staked|staking)(?:[^a-z]|$)/i;

export const EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: 'category-cex',
    label: 'exchange category: the venue already lists a token for itself',
    test: (p) => categoryKey(p) === 'CEX',
  },
  {
    id: 'category-bridge',
    label: 'bridge category: a route between chains, not a protocol waiting on a launch',
    test: (p) => BRIDGE_CATEGORIES.indexOf(categoryKey(p)) !== -1,
  },
  {
    id: 'category-liquid-staking',
    label: 'liquid staking or restaking: a receipt for a token that already trades',
    test: (p) => STAKING_CATEGORIES.indexOf(categoryKey(p)) !== -1,
  },
  {
    id: 'name-wrapped',
    label: 'the name carries wrapped, staked or staking: a receipt of a token that already exists',
    test: (p) => STAKING_WORD.test(p.name || ''),
  },
  {
    id: 'name-versioned',
    label: 'the name ends in a version marker: a pool or a fork of another protocol, not a protocol',
    test: (p) => VERSION_MARKER.test(p.name || ''),
  },
  {
    id: 'name-exchange',
    label: "the name opens with an exchange's: a product the exchange runs, not a launch of its own",
    test: (p) => {
      const head = String(p.name || '').toLowerCase().split(/[^a-z0-9.]+/)[0];
      if (!head) return false;
      for (const ex of EXCHANGE_NAMES) {
        if (head === ex || head.indexOf(ex) === 0) return true;
      }
      return false;
    },
  },
];

export interface ExclusionSummary {
  id: string;
  label: string;
  count: number;
}

export function excludedBy(p: SnapshotProtocol): string[] {
  const hits: string[] = [];
  for (const rule of EXCLUSION_RULES) {
    if (rule.test(p)) hits.push(rule.label);
  }
  return hits;
}

// ---------------------------------------------------------------------------------------
// Category multiples. The protocols that already trade price the ones that do not: a
// category's median market cap per dollar of TVL is what the market has been willing to
// pay for that kind of business, and it is the anchor the whole board is built on.
// ---------------------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarise(values: number[]): { samples: number; median: number; p25: number; p75: number } {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
  };
}

export interface CategoryMultiple {
  category: string;
  samples: number;
  median: number;
  p25: number;
  p75: number;
  source: 'category' | 'global';
}

export interface GlobalMultiple {
  samples: number;
  median: number;
  p25: number;
  p75: number;
}

export interface MultipleTable {
  global: GlobalMultiple;
  byCategory: Map<string, CategoryMultiple>;
  list: CategoryMultiple[];
}

const EMPTY_GLOBAL: GlobalMultiple = { samples: 0, median: 0.2, p25: 0.05, p75: 1, };
const EMPTY_MULTIPLE: CategoryMultiple = { category: '', samples: 0, median: 0.2, p25: 0.05, p75: 1, source: 'global' };

// Only a protocol that already trades says what its category is worth: it needs a real
// market cap and a real TVL for the ratio to mean anything.
export function buildMultiples(trading: SnapshotProtocol[]): MultipleTable {
  const perCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of trading) {
    const tvl = p.tvl_usd;
    const mcap = p.mcap_usd;
    if (!Number.isFinite(tvl) || tvl <= 0) continue;
    if (typeof mcap !== 'number' || !Number.isFinite(mcap) || mcap <= 0) continue;
    const multiple = mcap / tvl;
    if (!Number.isFinite(multiple) || multiple <= 0) continue;
    const key = categoryKey(p);
    const bucket = perCategory.get(key);
    if (bucket) bucket.push(multiple);
    else perCategory.set(key, [multiple]);
    all.push(multiple);
  }

  const globalStats = all.length > 0 ? summarise(all) : EMPTY_GLOBAL;
  const global: GlobalMultiple = all.length > 0 ? globalStats : EMPTY_GLOBAL;

  const list: CategoryMultiple[] = [];
  const byCategory = new Map<string, CategoryMultiple>();
  const keys = Array.from(perCategory.keys()).sort();
  for (const key of keys) {
    const values = perCategory.get(key) as number[];
    const stats = summarise(values);
    const thin = stats.samples < MODEL.min_category_samples;
    const entry: CategoryMultiple = {
      category: key,
      samples: stats.samples,
      median: thin ? global.median : stats.median,
      p25: thin ? global.p25 : stats.p25,
      p75: thin ? global.p75 : stats.p75,
      source: thin ? 'global' : 'category',
    };
    list.push(entry);
    byCategory.set(key, entry);
  }
  return { global, byCategory, list };
}

export interface AppliedMultiple {
  category: string;
  multiple: number;
  p25: number;
  p75: number;
  samples: number;
  source: 'category' | 'global';
}

export function appliedMultiple(table: MultipleTable, category: string): AppliedMultiple {
  const found = table.byCategory.get(category);
  if (found) {
    return {
      category,
      multiple: found.median,
      p25: found.p25,
      p75: found.p75,
      samples: found.samples,
      source: found.source,
    };
  }
  return {
    category,
    multiple: table.global.median,
    p25: table.global.p25,
    p75: table.global.p75,
    samples: 0,
    source: 'global',
  };
}

// ---------------------------------------------------------------------------------------
// Growth and maturity. Growth bends the value with the last seven days of TVL movement,
// capped so one volatile week cannot carry a row. Maturity says a protocol that has run
// longer without a token has more of it to distribute, capped at five years.
// ---------------------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function growthMultiplier(change7d: number | null): number {
  if (typeof change7d !== 'number' || !Number.isFinite(change7d)) return 1;
  const bounded = clamp(change7d, MODEL.growth_floor, MODEL.growth_cap);
  return 1 + (bounded / 100) * MODEL.growth_weight;
}

export function maturityYears(days: number | null): number {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return MODEL.unknown_age_years;
  return days / 365.25;
}

export function maturityMultiplier(years: number): number {
  const capped = Math.min(years, MODEL.maturity_cap_years);
  return MODEL.maturity_floor + (MODEL.maturity_range * capped) / MODEL.maturity_cap_years;
}

export function impliedValue(base: number, growth: number, maturity: number): number {
  const raw = base * growth * maturity;
  const rounded = Math.round(raw);
  if (!Number.isFinite(rounded)) return MODEL.min_implied_usd;
  return clamp(rounded, MODEL.min_implied_usd, MODEL.max_implied_usd);
}

// ---------------------------------------------------------------------------------------
// Playbooks. One per kind of business, each a set of middle steps between the two every
// row shares: getting funds onto the chain, and keeping a record afterwards.
// ---------------------------------------------------------------------------------------

export type PlaybookId =
  | 'dexs' | 'lending' | 'bridge' | 'derivatives' | 'yield'
  | 'aggregator' | 'launchpad' | 'default';

interface Playbook {
  id: PlaybookId;
  weight: number;      // how much of the row's TVL to move, as a fraction, for the size hint
  middle: (ctx: StepContext) => string[];
}

interface StepContext {
  name: string;
  chain: string;
  size: string;      // "$250"
  half: string;      // "$125"
  small: string;     // "$25"
  gas: string;       // "about $6"
  category: string;
}

function money(n: number): string {
  const rounded = Math.max(25, Math.round(n / 25) * 25);
  return '$' + rounded.toLocaleString('en-US');
}

function gasFor(size: number, chain: string): string {
  const l2 = /^(Base|Arbitrum|Optimism|Polygon|Scroll|zkSync Era|Linea|Blast|Manta|Morph|X Layer|Sonic|Sei|Celo|World Chain|Unichain|Berachain)$/i.test(chain);
  const cheap = /^(Solana|Sui|Aptos|Near|TON|Stacks|Starknet|Hyperliquid L1)$/i.test(chain);
  if (cheap) return 'about $1';
  if (l2) return 'about $2';
  const scaled = Math.max(3, Math.round(size * 0.02));
  return 'about $' + scaled;
}

const PLAYBOOKS: Playbook[] = [
  {
    id: 'dexs',
    weight: 0.08,
    middle: (c) => [
      `Swap ${c.size} into the ${c.chain} quote asset on ${c.name} in two or three ordinary trades rather than one, and keep the output in the same wallet: ${c.gas} in gas for the set, 10 minutes in all.`,
      `Add a small two-sided position of ${c.small} to the ${c.name} pool you traded against on ${c.chain}, narrow enough that you can withdraw it the same day: ${c.gas} in gas to open, 20 minutes to size and review.`,
      `Rebalance the ${c.name} position on ${c.chain} whenever it drifts past the edge of your range, and leave it rebalanced once a week: ${c.gas} in gas per rebalance, about 8 minutes each time.`,
      `Claim whatever fees ${c.name} has accrued on ${c.chain} and record the claim, so the wallet shows trading, providing and claiming rather than a single deposit: ${c.gas} in gas, 5 minutes.`,
    ],
  },
  {
    id: 'lending',
    weight: 0.12,
    middle: (c) => [
      `Deposit ${c.size} of the chain's main stablecoin as supply on ${c.name} via ${c.chain} and keep it supplied: ${c.gas} in gas, 15 minutes to set up, then 5 minutes a week to check the position.`,
      `Borrow a conservative ${c.small} against that supply on ${c.name}, keeping the health factor well above the platform's own warning line, and leave it borrowed for a full week: ${c.gas} in gas, 10 minutes.`,
      `Repay the ${c.name} borrow in full on ${c.chain} and borrow again the following week, so the wallet shows a repayment cycle rather than one deposit: ${c.gas} in gas per cycle, 10 minutes each time.`,
      `Write down the supply rate and the borrow rate ${c.name} is paying on ${c.chain} each time you cycle, so you can tell later whether the position was worth holding: no gas, 5 minutes a week.`,
    ],
  },
  {
    id: 'bridge',
    weight: 0.1,
    middle: (c) => [
      `Bridge ${c.size} onto ${c.chain} with ${c.name} itself rather than a third-party route, and check the arrival before you move on: ${c.gas} in gas for the transfer, about 10 minutes.`,
      `Bridge ${c.half} of it back out through ${c.name} to the chain you came from, so both directions of the route show usage rather than a one-way hop: ${c.gas} in gas, about 10 minutes.`,
      `Route one more transfer through ${c.name} a week later with a different asset, because a bridge is judged on the pairs it carries and not only on volume: ${c.gas} in gas, 10 minutes each time.`,
      `Keep a note of the ${c.name} transfer ids for each route on ${c.chain}, with the date and the amount, so a later snapshot can be matched to your own record: no gas, about 5 minutes.`,
    ],
  },
  {
    id: 'derivatives',
    weight: 0.15,
    middle: (c) => [
      `Open a small ${c.small} position on ${c.name} over ${c.chain} with a stop already set, and close it inside the same session: ${c.gas} in gas plus the platform's own fee, about 15 minutes.`,
      `Open a hedged pair the following week, one long and one short of similar size on ${c.name}, so the wallet is not simply directional: ${c.gas} in gas and fees, about 20 minutes.`,
      `Repeat one small hedged trade every week on ${c.name} and close it before the week ends, which is what an activity snapshot can see: ${c.gas} in gas per round trip, about 15 minutes each time.`,
      `Record the entry, the exit and the funding ${c.name} charged on ${c.chain} for every round trip, so a later reader can see a habit and not a single trade: no gas, 5 minutes a week.`,
    ],
  },
  {
    id: 'yield',
    weight: 0.12,
    middle: (c) => [
      `Deposit ${c.size} into the flagship vault ${c.name} runs on ${c.chain} and note the share price you entered at: ${c.gas} in gas, about 10 minutes to set up.`,
      `Leave the ${c.name} position compounding instead of withdrawing the yield, and re-read the vault's fee and cap before you add to it: no gas, 10 minutes once.`,
      `Add a second, smaller deposit of ${c.small} to ${c.name} on ${c.chain} once a week, so the vault sees a growing position rather than one entry: ${c.gas} in gas per deposit, 8 minutes each time.`,
      `Compare the ${c.name} share price against your entry price every week and write the difference down with the date: no gas, 5 minutes each time.`,
    ],
  },
  {
    id: 'aggregator',
    weight: 0.08,
    middle: (c) => [
      `Route ${c.size} of swaps through ${c.name} on ${c.chain} in three separate trades across two days, rather than one large order: ${c.gas} in gas for the set, about 15 minutes.`,
      `Compare the price ${c.name} quotes on ${c.chain} against a single venue for the same pair and keep a note of the difference: no gas, 10 minutes once.`,
      `Use ${c.name} again the following week for an ordinary trade you would have made anyway, so the usage is routine rather than a test: ${c.gas} in gas, about 5 minutes each time.`,
      `Record each ${c.name} route on ${c.chain} with the pair, the amount and the date, so the record shows a pattern across weeks: no gas, about 5 minutes a week.`,
    ],
  },
  {
    id: 'launchpad',
    weight: 0.1,
    middle: (c) => [
      `Read ${c.name}'s current sale terms on ${c.chain} and note the minimum, the vesting and the close date before you commit anything: no gas, about 15 minutes.`,
      `Take part in one ${c.name} sale cycle with ${c.small} on ${c.chain}, no more than you would be content to hold through a full vesting period: ${c.gas} in gas plus the sale's own fee, about 20 minutes.`,
      `Check the ${c.name} allocation and the claim schedule a week after the sale closes, and claim only what has actually vested: ${c.gas} in gas, about 10 minutes.`,
      `Write down what the ${c.name} sale cost you on ${c.chain} against what it returned, with the dates, so the next sale is a decision and not a guess: no gas, about 10 minutes.`,
    ],
  },
  {
    id: 'default',
    weight: 0.1,
    middle: (c) => [
      `Use ${c.name}'s core product on ${c.chain} with ${c.size} once, following its own documentation for the first transaction rather than a third-party guide: ${c.gas} in gas, about 15 minutes.`,
      `Hold a working balance inside ${c.name} on ${c.chain} instead of moving it in and out, because a balance that stays is what a snapshot of usage can see: no extra gas, 5 minutes.`,
      `Come back to ${c.name} once a week and use the same product again, so the address shows repeat use rather than a single visit: ${c.gas} in gas per visit, 10 minutes each time.`,
      `Check whether ${c.name} runs a public testnet or a points page on ${c.chain} and join it if it does, because those surfaces usually count earlier than any token does: no gas, 15 minutes once.`,
    ],
  },
];

// The category names come from the snapshot, so this is a lookup by keyword and never a
// roster of protocols: any category the snapshot gains lands on a playbook by its words.
export function playbookFor(category: string): string {
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

function playbookById(id: string): Playbook {
  for (const p of PLAYBOOKS) if (p.id === id) return p;
  return PLAYBOOKS[PLAYBOOKS.length - 1];
}

// A step is a single string a person can follow: it names the protocol, its main chain,
// what to do, and roughly what it costs and how long it takes.
export function stepText(text: string): string {
  let out = String(text).replace(/\s+/g, ' ').trim();
  if (out.length > FARM_STEP_MAX_CHARS) out = out.slice(0, FARM_STEP_MAX_CHARS - 1).trimEnd() + '.';
  return out;
}

export function farmSteps(p: SnapshotProtocol, category: string): FarmStep[] {
  const playbook = playbookById(playbookFor(category));
  const chain = (p.chains && p.chains.length > 0 && p.chains[0]) || 'its main chain';
  const tvl = Number.isFinite(p.tvl_usd) ? p.tvl_usd : 0;
  const budget = Math.max(50, Math.min(500, tvl * 0.0000015));
  const size = money(budget);
  const half = money(budget / 2);
  const small = money(Math.max(25, budget / 4));
  const gas = gasFor(budget, chain);

  const ctx: StepContext = { name: p.name, chain, size, half, small, gas, category };

  const first =
    `Get ${gas === 'about $1' ? 'a small amount' : 'about ' + size} of the chain's main stablecoin onto ${chain} in a wallet you control` +
    `, then connect that wallet to ${p.name} and read its own deposit page before you send anything: ${gas} in gas for the two transactions, about 15 minutes end to end.`;

  const last =
    `Keep a dated log of every ${p.name} transaction you made on ${chain}, with the amount, the date and the transaction hash` +
    `, and re-read it once a week so a snapshot can be matched to your own record: no gas, about 5 minutes a week.`;

  const middle = playbook.middle(ctx);
  const steps: FarmStep[] = [stepText(first), ...middle.map(stepText), stepText(last)];

  // The gate wants four to six steps between twenty and six hundred characters. Middle
  // steps are trimmed from the end when a playbook runs long, never the two fixed ends.
  while (steps.length > FARM_STEPS_MAX) steps.splice(steps.length - 2, 1);
  return steps;
}

// ---------------------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------------------

export interface Scored {
  protocol: SnapshotProtocol;
  category: string;
  multiple: AppliedMultiple;
  base: number;
  growth: number;
  maturityYears: number;
  maturity: number;
  figure: number;
  low: number;
  high: number;
  unlikely: boolean;
  reasons: string[];
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
  multiple_source: string;
  growth_multiplier: number;
  maturity_multiplier: number;
  maturity_years: number;
  model: Record<string, unknown>;
  farm_steps: FarmStep[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

export interface LaunchSummary {
  value: number;
  ceiling: number;
  plausible_floor_usd: number;
  largest_unlikely_figure_usd: number;
}

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
  rows: BoardRow[];
  live: LiveRow[];
  watchlist: string[];
}

function percentileOf(value: number, sorted: number[]): number {
  if (sorted.length <= 1) return 100;
  let below = 0;
  for (const v of sorted) if (v < value) below++;
  return Math.round((below / (sorted.length - 1)) * 1000) / 10;
}

// The launch factor. A protocol the watchlist leaves out keeps a small share of the value
// its figures imply, and the ceiling is shortened whenever the full ceiling would let a
// tagged protocol outrank the weakest plausible launch. One number for the whole board, so
// the tagged rows keep their order among themselves.
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

  const ceiling = MODEL.launch_likelihood_unlikely;
  if (largestUnlikely <= 0) {
    return { value: ceiling, ceiling, plausible_floor_usd: Number.isFinite(plausibleFloor) ? plausibleFloor : 0, largest_unlikely_figure_usd: 0 };
  }
  if (!anyPlausible || !Number.isFinite(plausibleFloor) || plausibleFloor <= 0) {
    return { value: ceiling, ceiling, plausible_floor_usd: 0, largest_unlikely_figure_usd: largestUnlikely };
  }

  const safe = (0.9 * plausibleFloor) / largestUnlikely;
  const value = Math.min(ceiling, safe);
  return {
    value,
    ceiling,
    plausible_floor_usd: plausibleFloor,
    largest_unlikely_figure_usd: largestUnlikely,
  };
}

export interface BoardBuild {
  rows: BoardRow[];
  scored: Scored[];
  launch: LaunchSummary;
  exclusions: ExclusionSummary[];
}

export function buildBoard(snapshot: Snapshot, table: MultipleTable): BoardBuild {
  const watch = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter(isPreToken);
  const trading = snapshot.protocols.filter((p) => !isPreToken(p));

  const scored: Scored[] = [];
  for (const p of preToken) {
    const category = categoryKey(p);
    const multiple = appliedMultiple(table, category);
    const tvl = Number.isFinite(p.tvl_usd) && p.tvl_usd > 0 ? p.tvl_usd : 0;
    const base = tvl * multiple.multiple;
    const growth = growthMultiplier(p.change_7d);
    const days = ageDays(snapshot.as_of, p.listed_at);
    const years = maturityYears(days);
    const maturity = maturityMultiplier(years);
    const figure = impliedValue(base, growth, maturity);
    const low = impliedValue(tvl * multiple.p25, growth, maturity);
    const high = impliedValue(tvl * multiple.p75, growth, maturity);
    const reasons = excludedBy(p);
    scored.push({
      protocol: p,
      category,
      multiple,
      base,
      growth,
      maturityYears: years,
      maturity,
      figure,
      low,
      high,
      unlikely: reasons.length > 0,
      reasons,
    });
  }

  const launch = launchFactor(scored);

  // Count how often each rule fires, for the page's own statement of the logic. The rules
  // are counted over the pre-token set, so the numbers on the page add up to the flags.
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

  // Value descending, then the plausible launches ahead of the tagged ones, then TVL, then
  // slug. The comparator is total, so the order never depends on the input order.
  const withValue = scored.map((s) => {
    const likelihood = s.unlikely ? launch.value : MODEL.launch_likelihood_plausible;
    const implied = Math.round(s.figure * likelihood);
    return {
      s,
      implied: Math.max(MODEL.min_implied_usd, Math.min(MODEL.max_implied_usd, implied)),
    };
  });

  withValue.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    if (a.s.unlikely !== b.s.unlikely) return a.s.unlikely ? 1 : -1;
    if (b.s.protocol.tvl_usd !== a.s.protocol.tvl_usd) return b.s.protocol.tvl_usd - a.s.protocol.tvl_usd;
    return a.s.protocol.slug < b.s.protocol.slug ? -1 : a.s.protocol.slug > b.s.protocol.slug ? 1 : 0;
  });

  const impliedSorted = withValue.map((w) => w.implied).sort((a, b) => a - b);
  let plausibleCounter = 0;

  const rows: BoardRow[] = withValue.map((w, index) => {
    const s = w.s;
    const p = s.protocol;
    const likelihood = s.unlikely ? launch.value : MODEL.launch_likelihood_plausible;
    const plausibleRank = s.unlikely ? null : ++plausibleCounter;
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
      watchlist: watch.has(p.slug),
      launch_unlikely: s.unlikely,
      unlikely_reasons: s.reasons.slice(),
      launch_reason: s.reasons.join('; '),
      playbook: playbookFor(s.category),
      implied_value_usd: w.implied,
      implied_low_usd: Math.max(MODEL.min_implied_usd, Math.round(s.low * likelihood)),
      implied_high_usd: Math.max(MODEL.min_implied_usd, Math.min(MODEL.max_implied_usd, Math.round(s.high * likelihood))),
      expected_airdrop_usd: Math.max(1, Math.round(w.implied * MODEL.community_allocation * MODEL.eligibility_share)),
      percentile: percentileOf(w.implied, impliedSorted),
      plausible_rank: plausibleRank,
      launch_likelihood: likelihood,
      base_usd: Math.round(s.base),
      figure_value_usd: s.figure,
      category_multiple: s.multiple.multiple,
      category_samples: s.multiple.samples,
      multiple_source: s.multiple.source,
      growth_multiplier: s.growth,
      maturity_multiplier: s.maturity,
      maturity_years: s.maturityYears,
      model: {
        figure_value_usd: s.figure,
        base_usd: Math.round(s.base),
        category_multiple: s.multiple.multiple,
        category_samples: s.multiple.samples,
        multiple_source: s.multiple.source,
        multiple_category: s.category,
        growth_pct: p.change_7d,
        growth_multiplier: s.growth,
        maturity_years: s.maturityYears,
        maturity_multiplier: s.maturity,
        age_days: ageDays(snapshot.as_of, p.listed_at),
        community_allocation: MODEL.community_allocation,
        eligibility_share: MODEL.eligibility_share,
        launch_likelihood: likelihood,
      },
      farm_steps: farmSteps(p, s.category),
    };
  });

  return { rows, scored, launch, exclusions };
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  const out: LiveRow[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    const tvl = p.tvl_usd;
    const mcap = p.mcap_usd;
    const multiple =
      Number.isFinite(tvl) && tvl > 0 && typeof mcap === 'number' && Number.isFinite(mcap) && mcap > 0
        ? mcap / tvl
        : null;
    out.push({
      slug: p.slug,
      name: p.name,
      category: categoryKey(p),
      chains: p.chains.slice(),
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple,
    });
  }
  out.sort((a, b) => {
    const am = a.mcap_usd === null ? -1 : a.mcap_usd;
    const bm = b.mcap_usd === null ? -1 : b.mcap_usd;
    if (bm !== am) return bm - am;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// Reading the snapshot, and writing the two files main.ts depends on.
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

export function buildRadar(snapshot: Snapshot): RadarData {
  const trading = snapshot.protocols.filter((p) => !isPreToken(p));
  const preToken = snapshot.protocols.filter(isPreToken);
  const table = buildMultiples(trading);
  const { rows, launch, exclusions } = buildBoard(snapshot, table);
  const live = liveRows(snapshot);

  const watchSet = new Set(snapshot.watchlist);
  let covered = 0;
  for (const slug of watchSet) if (preToken.some((p) => p.slug === slug)) covered++;

  const plausible = rows.filter((r) => !r.launch_unlikely).length;
  const unlikely = rows.length - plausible;

  const launchPct = (launch.value * 100).toFixed(4);

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    model_summary: MODEL_SUMMARY,
    counts: {
      protocols_scanned: snapshot.protocols.length,
      pre_token: preToken.length,
      already_trading: trading.length,
      watchlist_size: snapshot.watchlist.length,
      watchlist_covered: covered,
      board_size: rows.length,
      plausible,
      launch_unlikely: unlikely,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    early_size: rows.filter((r) => r.watchlist).length + Math.max(0, plausible - rows.filter((r) => r.watchlist).length),
    live_size: live.length,
    protocols_scanned: snapshot.protocols.length,
    global_multiple: table.global,
    multiples: table.list,
    exclusions,
    assumptions: {
      community_allocation: MODEL.community_allocation,
      eligibility_share: MODEL.eligibility_share,
      launch_likelihood: launch.value,
      launch_likelihood_ceiling: launch.ceiling,
      plausible_floor_usd: Math.round(launch.plausible_floor_usd),
      largest_unlikely_figure_usd: launch.largest_unlikely_figure_usd,
      note:
        'Expected airdrop is a stated assumption, not a promise: it takes ' +
        Math.round(MODEL.community_allocation * 100) + '% of the implied value as a community allocation and ' +
        Math.round(MODEL.eligibility_share * 100) + '% of that as one wallet\'s share. ' +
        'The launch factor is the other stated assumption: a protocol the watchlist definition leaves out keeps ' +
        launchPct + '% of the value its figures imply, at most ' + Math.round(launch.ceiling * 100) +
        '%, and the ceiling is shortened whenever the full ceiling would let a tagged protocol outrank the weakest plausible launch.',
    },
    rows,
    live,
    watchlist: snapshot.watchlist.slice(),
  };
  return radar;
}

// The same assertions the gate applies, run before a byte is written, so a broken board
// fails here instead of at submission.
export function boardIssue(radar: RadarData): string | null {
  const rows = radar.rows;
  if (rows.length < MIN_BOARD_ROWS) return 'the board holds ' + rows.length + ' rows, under the ' + MIN_BOARD_ROWS + ' the gate requires';
  if (rows.length > MAX_BOARD_ROWS) return 'the board holds ' + rows.length + ' rows, over the ' + MAX_BOARD_ROWS + ' the gate allows';

  const slugs = new Set<string>();
  let previous = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r.slug !== 'string' || r.slug === '') return 'row ' + (i + 1) + ' has no slug';
    if (slugs.has(r.slug)) return 'the slug ' + r.slug + ' appears twice';
    slugs.add(r.slug);
    if (!r.name) return 'the row ' + r.slug + ' has no name';
    if (r.rank !== i + 1) return 'the rank of ' + r.slug + ' is ' + r.rank + ', not ' + (i + 1);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1) return 'the implied value of ' + r.slug + ' is not a positive whole number of dollars';
    if (r.implied_value_usd > MODEL.max_implied_usd) return 'the implied value of ' + r.slug + ' is over the cap';
    if (r.implied_value_usd > previous) return 'the implied value rises at ' + r.slug + ' (rank ' + r.rank + ')';
    previous = r.implied_value_usd;
    if (r.farm_steps.length < FARM_STEPS_MIN || r.farm_steps.length > FARM_STEPS_MAX) {
      return 'the plan for ' + r.slug + ' has ' + r.farm_steps.length + ' steps';
    }
    for (const step of r.farm_steps) {
      if (typeof step !== 'string') return 'a step for ' + r.slug + ' is not a string';
      const trimmed = step.trim();
      if (trimmed.length < FARM_STEP_MIN_CHARS || trimmed.length > FARM_STEP_MAX_CHARS) {
        return 'a step for ' + r.slug + ' is ' + trimmed.length + ' characters';
      }
    }
  }

  for (const slug of radar.watchlist) {
    if (!slugs.has(slug)) return 'the watchlist slug ' + slug + ' is not on the board';
  }

  const tagged = rows.filter((r) => r.launch_unlikely);
  const plausible = rows.filter((r) => !r.launch_unlikely);
  for (const t of tagged) {
    for (const p of plausible) {
      if (t.rank < p.rank) return 'the tagged row ' + t.slug + ' ranks above the plausible launch ' + p.slug;
    }
  }
  const taggedFactor = new Set(tagged.map((r) => r.launch_likelihood));
  if (taggedFactor.size > 1) return 'the tagged rows do not share one launch factor';
  for (const f of taggedFactor) {
    if (!(f > 0) || f > MODEL.launch_likelihood_unlikely) return 'the launch factor ' + f + ' is outside its range';
  }
  for (const r of tagged) {
    const expected = Math.round(r.figure_value_usd * r.launch_likelihood);
    if (Math.abs(expected - r.implied_value_usd) > 1) {
      return 'the implied value of ' + r.slug + ' is not its figure times the launch factor';
    }
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return '// Written by main.ts from the sealed snapshot. Generated: do not edit by hand.\nwindow.RADAR=' +
    JSON.stringify(radar) + ';\n';
}
