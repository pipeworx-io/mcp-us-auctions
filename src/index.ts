interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * US Auctions MCP — every live US auction lot in the consolidated index,
 * government AND commercial, read from auction_lots / auction_events (ingested
 * by workers/auction-scraper) over PostgREST.
 *
 * Relationship to the neighbouring packs:
 *   - mcps/gov-auctions  — the same store filtered to segment='government'
 *     (GovDeals, AllSurplus, PublicSurplus, Bid4Assets, IRS, txauction). Kept
 *     separate because it is published to npm and the MCP Registry with that
 *     contract; a caller asking for surplus trucks must not get estate-sale
 *     antiques.
 *   - mcps/gsa-auctions  — the live GSA federal-surplus API, not DB-backed.
 *   - THIS pack          — the whole picture, plus the two shapes only the
 *     commercial half has: auction EVENTS (a sale) and auction HOUSES (a seller).
 *
 * The moat is the same one: closed lots are never deleted, so final_price
 * accumulates into sold comps no upstream site retains.
 *
 * Stateless (the gateway owns auth/rate-limiting) and never throws for an
 * expected empty result — it shapes LLM-friendly objects and returns { error }.
 */


const ASSET_TYPES = ['vehicle', 'equipment', 'realestate', 'electronics', 'other'] as const;
const SEGMENTS = ['government', 'commercial'] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'us_auctions_search',
    description:
      'Search live US auction lots across every source Pipeworx indexes — commercial auction houses (HiBid: ~1,900 US auctioneers, industrial liquidations, estate and equipment sales) and government surplus/seized/tax-deed sales (GovDeals, AllSurplus, PublicSurplus, Bid4Assets, IRS). Filter by free-text keyword (matched on the lot title, e.g. "forklift", "excavator", "F-150"), 2-letter state, asset_type (vehicle|equipment|realestate|electronics|other), segment (commercial|government), auction_house, max_price and closing_within_hours — or search geographically with near_zip + radius_miles ("forklifts within 50 miles of 94402"), which returns lots ordered by distance. Keyword search is full-text over the lot title AND description, so "cnc lathe" finds a lot titled "Haas TL-1" whose description says CNC lathe. Returns each lot with source, title, selling house, location, current bid, close time and a link. For what things actually SOLD for, use us_auctions_sold_comps instead.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free-text matched (case-insensitive) against the lot title, e.g. "forklift", "skid steer", "mac pro".' },
        state: { type: 'string', description: '2-letter state code of the item location, e.g. "CA", "TX".' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        segment: { type: 'string', description: `Restrict to one half of the market: ${SEGMENTS.join(' | ')}. Omit for both.` },
        source: { type: 'string', description: 'Restrict to one source: hibid | govdeals | allsurplus | publicsurplus | bid4assets | irs | txauction.' },
        auction_house: { type: 'string', description: 'Selling auctioneer, matched as a substring, e.g. "Silicon Valley Disposition".' },
        near_zip: { type: 'string', description: 'US 5-digit ZIP to search around, e.g. "94402". Combine with radius_miles for "what is up for auction near me". Results come back ordered by distance and carry distance_miles.' },
        radius_miles: { type: ['number', 'string'], description: 'Radius around near_zip, in miles (1-500, default 50). Ignored unless near_zip is given.' },
        max_price: { type: ['number', 'string'], description: 'Only lots whose current bid is at or below this. Note that a lot with no bids yet has no current bid and is excluded.' },
        closing_within_hours: { type: ['number', 'string'], description: 'Only lots closing within this many hours from now.' },
        limit: { type: ['number', 'string'], description: 'Max lots (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'us_auctions_closing_soon',
    description:
      'US auction lots ordered by soonest close time — the "what can I still bid on before it ends" view across commercial and government sources alike. Optionally filter by state, asset_type, segment, auction_house or keyword. Returns lots with hours remaining, current bid, location and link.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '2-letter state code.' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        segment: { type: 'string', description: `${SEGMENTS.join(' | ')}. Omit for both.` },
        source: { type: 'string', description: 'Restrict to one source.' },
        auction_house: { type: 'string', description: 'Selling auctioneer, substring match.' },
        keyword: { type: 'string', description: 'Free-text search over lot title and description.' },
        near_zip: { type: 'string', description: 'US 5-digit ZIP to search around, e.g. "94402".' },
        radius_miles: { type: ['number', 'string'], description: 'Radius around near_zip in miles (1-500, default 50).' },
        limit: { type: ['number', 'string'], description: 'Max lots (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'us_auction_events',
    description:
      'Upcoming US auction EVENTS — the sales themselves rather than individual lots ("Synthetic Fuels Company plant liquidation, 271 lots, Aug 28, Fremont CA"). Use this to answer "what auctions are happening near me next week" or "what is this auction house selling". Filter by state, keyword (sale title), auction_house, and a closing date range. Returns each sale with its house, location, lot count, local sale date and a link. Sale dates are the auctioneer\'s LOCAL calendar date — upstream publishes them without a timezone, so a precise instant is not available at the sale level; individual lot close times (us_auctions_closing_soon) are exact.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '2-letter state code where the sale is held.' },
        keyword: { type: 'string', description: 'Free-text matched against the sale title, e.g. "liquidation", "estate", "machine shop".' },
        auction_house: { type: 'string', description: 'Selling auctioneer, substring match, e.g. "Silicon Valley Disposition".' },
        closes_after: { type: 'string', description: 'Only sales closing on or after this date (YYYY-MM-DD). Defaults to today.' },
        closes_before: { type: 'string', description: 'Only sales closing on or before this date (YYYY-MM-DD).' },
        min_lots: { type: ['number', 'string'], description: 'Only sales with at least this many lots — useful for filtering out one-off listings.' },
        limit: { type: ['number', 'string'], description: 'Max sales (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'us_auction_houses',
    description:
      'Which US auction houses Pipeworx covers, and how much they currently have live — name, home state, number of open sales and total lots across them. Use to find the auctioneers active in a state or in a niche ("who runs industrial liquidations in California"), then pass the name to us_auction_events or us_auctions_search. Ranked by live lot count.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '2-letter state code of the sale location.' },
        keyword: { type: 'string', description: 'Free-text matched against the house name or its sale titles.' },
        limit: { type: ['number', 'string'], description: 'Max houses (1-100, default 25).' },
      },
      required: [],
    },
  },
  {
    name: 'us_auctions_sold_comps',
    description:
      'Historical SOLD prices for US auction items — the final hammer price of closed lots, which no upstream site keeps but Pipeworx retains across both the commercial and government halves of the market. Use to answer "what do used forklifts actually fetch at auction" or to comp an asset before bidding. Filter by keyword (title match), asset_type, state and segment. Returns count, min/median/average/max final price, and recent examples. Only lots that closed with a recorded sale price above zero are counted — a closed lot that drew no bids is not a comp.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Free-text title match, e.g. "forklift", "f-150", "cnc lathe".' },
        asset_type: { type: 'string', description: `One of: ${ASSET_TYPES.join(' | ')}.` },
        state: { type: 'string', description: '2-letter state code.' },
        segment: { type: 'string', description: `${SEGMENTS.join(' | ')}. Commercial and government prices differ materially for the same asset — split them when it matters.` },
        limit: { type: ['number', 'string'], description: 'Max example lots to return (1-50, default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'us_auctions_coverage',
    description:
      'Current US auction coverage: per-source active lot counts, open sale counts, retained sold comps, and when each source last refreshed. Use to gauge breadth and freshness before relying on the data.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

interface SupabaseConfig {
  url: string;
  key: string;
}

async function pg<T>(cfg: SupabaseConfig, table: string, query: string): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`data query ${table}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Exact row count via PostgREST's Content-Range header. Aggregate functions and
 * `group=` are DISABLED on this project (PGRST123), so count() is unavailable —
 * ask for one row with Prefer: count=exact and read the "0-0/1234" tail.
 */
async function pgCount(cfg: SupabaseConfig, table: string, query: string): Promise<number> {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return 0;
  const range = res.headers.get('content-range') ?? '';
  const n = Number(range.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}

// Every source the auction-scraper ingests, and which half of the market it is.
// KEEP IN SYNC with workers/auction-scraper/src/sources/index.ts. The gov pack's
// copy of this list drifted for six weeks and made auctions_coverage under-report
// by three sources while returning a clean 200 — don't repeat that here.
const SOURCES: Array<{ source: string; segment: (typeof SEGMENTS)[number]; label: string }> = [
  { source: 'hibid', segment: 'commercial', label: 'HiBid — ~1,900 US auction houses' },
  { source: 'govdeals', segment: 'government', label: 'GovDeals — state & local surplus' },
  { source: 'allsurplus', segment: 'government', label: 'AllSurplus (also govliquidation.com, go-dove.com)' },
  { source: 'publicsurplus', segment: 'government', label: 'PublicSurplus — agency surplus' },
  { source: 'bid4assets', segment: 'government', label: 'Bid4Assets — county tax & sheriff sales' },
  { source: 'irs', segment: 'government', label: 'IRS seized & forfeited property' },
  { source: 'txauction', segment: 'government', label: 'Gaston & Sheehan — US Marshals contractor' },
];

interface LotRow {
  source: string;
  source_lot_id: string;
  segment: string;
  title: string;
  description: string | null;
  category: string | null;
  asset_type: string | null;
  location_city: string | null;
  location_state: string | null;
  location_zip: string | null;
  currency: string;
  current_bid: number | null;
  bid_count: number | null;
  final_price: number | null;
  closes_at: string | null;
  status: string;
  seller_agency: string | null;
  auction_house: string | null;
  source_event_id: string | null;
  url: string | null;
}

interface EventRow {
  source: string;
  source_event_id: string;
  title: string;
  auction_house: string | null;
  house_url: string | null;
  location_city: string | null;
  location_state: string | null;
  lot_count: number | null;
  starts_on: string | null;
  closes_on: string | null;
  closes_at: string | null;
  status: string;
  url: string | null;
}

const LOT_SELECT =
  'select=source,source_lot_id,segment,title,category,asset_type,location_city,location_state,location_zip,currency,current_bid,bid_count,closes_at,status,seller_agency,auction_house,source_event_id,url';
const EVENT_SELECT =
  'select=source,source_event_id,title,auction_house,house_url,location_city,location_state,lot_count,starts_on,closes_on,closes_at,status,url';

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

/**
 * Drop the second copy of a lot that is listed on two storefronts of the same
 * platform.
 *
 * GovDeals and AllSurplus are both Liquidity Services sites over the same
 * maestro API, and a lot on both carries an IDENTICAL source_lot_id (the
 * composite accountId-auctionId-assetId). Measured 2026-08-26: 42,010 of
 * govdeals' 44,462 active lots — 94% — are also live under allsurplus. Without
 * this, a plain search for "forklift" spent half its result slots showing the
 * same forklift twice, and every count we published was ~47% double.
 *
 * govdeals wins, matching auction_distinct_active_count()'s canonical side, so
 * the count and the results agree about which copy is real. Keyed on
 * source_lot_id ALONE and only within that family — ids from different platforms
 * are unrelated namespaces and must never collide here.
 */
const DUPLICATE_STOREFRONTS = new Set(['govdeals', 'allsurplus']);

function dedupeStorefronts<T extends { source: string; source_lot_id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  // govdeals first so it is the copy that survives, whatever order the DB
  // returned — but original ordering is otherwise preserved, because these
  // lists are sorted by close time and re-sorting would break that contract.
  const preferred = rows.filter((r) => r.source === 'govdeals');
  const rest = rows.filter((r) => r.source !== 'govdeals');
  for (const r of [...preferred, ...rest]) {
    if (!DUPLICATE_STOREFRONTS.has(r.source)) { out.push(r); continue; }
    if (seen.has(r.source_lot_id)) continue;
    seen.add(r.source_lot_id);
    out.push(r);
  }
  // Restore the caller-visible ordering the query asked for.
  const rank = new Map(rows.map((r, i) => [`${r.source} ${r.source_lot_id}`, i]));
  return out.sort((a, b) => (rank.get(`${a.source} ${a.source_lot_id}`) ?? 0) - (rank.get(`${b.source} ${b.source_lot_id}`) ?? 0));
}

/**
 * How many rows to ask for so that `limit` SURVIVE the dedupe. At the measured
 * 94% overlap a plain fetch of `limit` rows can come back nearly half empty,
 * which reads as "we barely have anything" rather than "we filtered".
 */
function overFetch(limit: number): number {
  return Math.min(limit * 2, 200);
}

function shapeLot(r: LotRow) {
  return {
    source: r.source,
    source_lot_id: r.source_lot_id,
    segment: r.segment,
    title: r.title,
    category: r.category,
    asset_type: r.asset_type,
    auction_house: r.auction_house ?? r.seller_agency,
    location: [r.location_city, r.location_state].filter(Boolean).join(', ') || null,
    state: r.location_state,
    current_bid: r.current_bid,
    currency: r.currency,
    bid_count: r.bid_count,
    closes_at: r.closes_at,
    url: r.url,
  };
}

function shapeEvent(r: EventRow) {
  return {
    source: r.source,
    source_event_id: r.source_event_id,
    title: r.title,
    auction_house: r.auction_house,
    house_url: r.house_url,
    location: [r.location_city, r.location_state].filter(Boolean).join(', ') || null,
    state: r.location_state,
    lot_count: r.lot_count,
    opens_on: r.starts_on,
    // Named _local because upstream publishes a wall-clock date with no
    // timezone. Calling it closes_at would invite a caller to treat it as an
    // instant, which it is not.
    closes_on_local: r.closes_on,
    url: r.url,
  };
}

/**
 * The caller's keyword, under any of the param names agents actually reach for.
 * A pack that honors only `keyword` silently returns the whole unfiltered pool
 * as though it had matched — which reads as a working search returning odd
 * results, not as a bug.
 */
function keywordOf(args: Record<string, unknown>): string {
  return String(args.keyword ?? args.query ?? args.q ?? args.search ?? args.keywords ?? '').trim();
}

/**
 * Full-text filter against the stored, weighted search_tsv column (migration
 * 092) — title weighted above auction house above category above description.
 * `wfts` is websearch_to_tsquery, which is forgiving about the punctuation and
 * quoting real users type.
 *
 * This is the PRIMARY matcher: it stems ("lathes" finds "lathe") and it reaches
 * the description, so "cnc lathe" finds a lot titled "Haas TL-1". What it cannot
 * do is match a fragment of a word — see substringParts for that fallback.
 */
function ftsParts(args: Record<string, unknown>): string[] {
  const keyword = keywordOf(args);
  if (!keyword) return [];
  // A tsquery of only stopwords/punctuation matches nothing at all, which would
  // read as "no results" rather than "your query had no searchable terms".
  if (!/[a-z0-9]{2,}/i.test(keyword)) return [];
  return [`search_tsv=wfts(english).${encodeURIComponent(keyword)}`];
}

/**
 * Trigram substring fallback, AND-ed per token so word order doesn't matter.
 * Full-text can't match inside a word, and auction titles are full of partial
 * model numbers and abbreviations people search by ("bobcat s7" for "S770").
 * Only used when the full-text pass came back empty, so the common case still
 * costs one query.
 */
function substringParts(args: Record<string, unknown>, column = 'title'): string[] {
  const keyword = keywordOf(args);
  if (!keyword) return [];
  return keyword
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 6)
    .map((tok) => `${column}=ilike.*${encodeURIComponent(tok)}*`);
}

function normalizeAssetType(raw: string): string {
  if (!raw) return '';
  const t = raw.toLowerCase();
  const map: Record<string, string> = {
    vehicles: 'vehicle', car: 'vehicle', cars: 'vehicle', truck: 'vehicle', trucks: 'vehicle', auto: 'vehicle',
    equipment: 'equipment', machinery: 'equipment', heavy: 'equipment', industrial: 'equipment',
    realestate: 'realestate', 'real estate': 'realestate', property: 'realestate', land: 'realestate',
    electronics: 'electronics', electronic: 'electronics', computers: 'electronics', computer: 'electronics',
  };
  if ((ASSET_TYPES as readonly string[]).includes(t)) return t;
  return map[t] ?? '';
}

function normalizeSegment(raw: unknown): string {
  const t = String(raw ?? '').trim().toLowerCase();
  if ((SEGMENTS as readonly string[]).includes(t)) return t;
  if (/^gov/.test(t)) return 'government';
  if (/^(comm|private|business)/.test(t)) return 'commercial';
  return '';
}

function segmentPart(args: Record<string, unknown>): string[] {
  const seg = normalizeSegment(args.segment ?? args.market ?? args.type);
  return seg ? [`segment=eq.${seg}`] : [];
}

function housePart(args: Record<string, unknown>): string[] {
  const house = String(args.auction_house ?? args.house ?? args.auctioneer ?? args.seller ?? '').trim();
  return house ? [`auction_house=ilike.*${encodeURIComponent(house)}*`] : [];
}

function activeLotFilters(args: Record<string, unknown>): string[] {
  const parts = ['status=eq.active'];
  parts.push(...ftsParts(args));
  parts.push(...segmentPart(args));
  parts.push(...housePart(args));
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const source = String(args.source ?? '').trim().toLowerCase();
  if (source) parts.push(`source=eq.${encodeURIComponent(source)}`);
  return parts;
}

async function rpc<T>(cfg: SupabaseConfig, fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`data query ${fn}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Normalize whatever the caller passed as a ZIP down to 5 digits, or null. */
function zipOf(args: Record<string, unknown>): string | null {
  const raw = String(args.near_zip ?? args.zip ?? args.zipcode ?? args.postal_code ?? '').trim();
  const digits = raw.replace(/[^0-9]/g, '').slice(0, 5);
  return digits.length === 5 ? digits : null;
}

interface NearRow {
  source: string;
  source_lot_id: string;
  segment: string;
  title: string;
  asset_type: string | null;
  auction_house: string | null;
  location_city: string | null;
  location_state: string | null;
  location_zip: string | null;
  current_bid: number | null;
  currency: string;
  bid_count: number | null;
  closes_at: string | null;
  url: string | null;
  distance_miles: number;
}

/**
 * Radius search, via the search_auction_lots_near RPC (migration 092).
 * PostgREST cannot express distance, and the coordinates themselves come from
 * the us_zip_centroids join the ingest trigger applies — most sources publish a
 * ZIP and nothing more precise, so a lot's position is its town's position.
 * Said plainly in the response rather than implied, because "2.3 miles away"
 * reads as a street address and it is not one.
 */
async function nearSearch(cfg: SupabaseConfig, args: Record<string, unknown>, zip: string) {
  const centre = await pg<Array<{ zip: string; city: string | null; state: string | null; latitude: number; longitude: number }>>(
    cfg,
    'us_zip_centroids',
    `zip=eq.${encodeURIComponent(zip)}&select=zip,city,state,latitude,longitude&limit=1`,
  );
  if (centre.length === 0) {
    return { error: 'unknown_zip', message: `${zip} is not a US ZIP code we hold a centroid for. Use a 5-digit US ZIP, or search by state instead.` };
  }
  const c = centre[0];
  const miles = Math.min(Math.max(Number(args.radius_miles ?? args.radius ?? 50) || 50, 1), 500);
  const rows = await rpc<NearRow[]>(cfg, 'search_auction_lots_near', {
    p_lat: c.latitude,
    p_lon: c.longitude,
    p_miles: miles,
    p_query: keywordOf(args) || null,
    p_segment: normalizeSegment(args.segment ?? args.market) || null,
    p_asset_type: normalizeAssetType(String(args.asset_type ?? args.category ?? '').trim()) || null,
    p_max_price: args.max_price !== undefined && String(args.max_price).trim() !== '' ? Number(args.max_price) : null,
    p_limit: overFetch(clampInt(args.limit, 1, 100, 25)),
  });
  const deduped = dedupeStorefronts(rows).slice(0, clampInt(args.limit, 1, 100, 25));
  return {
    count: deduped.length,
    searched_around: { zip: c.zip, city: c.city, state: c.state, radius_miles: miles },
    distance_basis: 'Straight-line miles from the ZIP centroid of the lot\'s location to the ZIP centroid of the search point — town-level, not street-level.',
    lots: deduped.map((r) => ({
      source: r.source,
      source_lot_id: r.source_lot_id,
      segment: r.segment,
      title: r.title,
      asset_type: r.asset_type,
      auction_house: r.auction_house,
      location: [r.location_city, r.location_state].filter(Boolean).join(', ') || null,
      state: r.location_state,
      distance_miles: r.distance_miles,
      current_bid: r.current_bid,
      currency: r.currency,
      bid_count: r.bid_count,
      closes_at: r.closes_at,
      url: r.url,
    })),
  };
}

async function search(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const zip = zipOf(args);
  if (zip) return nearSearch(cfg, args, zip);

  const parts = activeLotFilters(args);
  if (args.max_price !== undefined && String(args.max_price).trim() !== '') {
    parts.push(`current_bid=lte.${Number(args.max_price)}`);
  }
  const nowIso = new Date().toISOString();
  const limit = clampInt(args.limit, 1, 100, 25);

  if (args.closing_within_hours !== undefined && String(args.closing_within_hours).trim() !== '') {
    const cutoff = new Date(Date.now() + Number(args.closing_within_hours) * 3600_000).toISOString();
    parts.push(`closes_at=lte.${cutoff}`, `closes_at=gte.${nowIso}`);
    parts.push(LOT_SELECT, 'order=closes_at.asc.nullslast', `limit=${limit}`);
    const rows = await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'));
    return { count: rows.length, lots: rows.map(shapeLot) };
  }

  // Two index-friendly passes rather than one `or=(closes_at.gte.NOW,is.null)`.
  // Results are ordered soonest-close-first, so with no floor the stalest
  // already-ended lots surface at the TOP of every plain search. But Postgres
  // cannot serve that OR from an index while also sorting on closes_at, and on
  // the unfiltered "what's for sale" call — the plainest there is — that scanned
  // the whole active pool and intermittently blew the 8s statement timeout,
  // alternating between a hard 500 and a silent empty result. Splitting it
  // returns identical rows in identical order, because `nullslast` already puts
  // every null-close lot after every dated one.
  const want = overFetch(limit);
  const dated = await pg<LotRow[]>(
    cfg,
    'auction_lots',
    [...parts, `closes_at=gte.${nowIso}`, LOT_SELECT, 'order=closes_at.asc', `limit=${want}`].join('&'),
  );
  const raw =
    dated.length >= want
      ? dated
      : dated.concat(
          await pg<LotRow[]>(
            cfg,
            'auction_lots',
            [...parts, 'closes_at=is.null', LOT_SELECT, `limit=${want - dated.length}`].join('&'),
          ),
        );
  const rows = dedupeStorefronts(raw).slice(0, limit);

  // Full-text found nothing but the caller did give a keyword — retry as a
  // trigram substring match before reporting an empty result. Auction titles
  // are full of partial model numbers ("bobcat s7" for an S770) that a tsquery
  // cannot match inside a word. Costs a second query only on the empty path.
  if (rows.length === 0 && keywordOf(args)) {
    const fallbackParts = activeLotFilters(args)
      .filter((p) => !p.startsWith('search_tsv='))
      .concat(substringParts(args));
    const fbRaw = await pg<LotRow[]>(
      cfg,
      'auction_lots',
      [...fallbackParts, `closes_at=gte.${nowIso}`, LOT_SELECT, 'order=closes_at.asc', `limit=${overFetch(limit)}`].join('&'),
    );
    const fb = dedupeStorefronts(fbRaw).slice(0, limit);
    if (fb.length > 0) return { count: fb.length, matched_by: 'partial-word match', lots: fb.map(shapeLot) };
  }

  return { count: rows.length, lots: rows.map(shapeLot) };
}

async function closingSoon(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const zip = zipOf(args);
  if (zip) {
    // Same radius query, re-ordered by close time — this tool's whole point is
    // the ordering, and the RPC sorts by distance.
    const near = await nearSearch(cfg, args, zip);
    if ('error' in near) return near;
    const now = Date.now();
    return {
      ...near,
      lots: near.lots
        .filter((l) => l.closes_at)
        .sort((a, b) => new Date(a.closes_at as string).getTime() - new Date(b.closes_at as string).getTime())
        .map((l) => ({ ...l, hours_remaining: Math.round(((new Date(l.closes_at as string).getTime() - now) / 3600_000) * 10) / 10 })),
    };
  }

  const parts = activeLotFilters(args);
  parts.push(`closes_at=gte.${new Date().toISOString()}`);
  const limit = clampInt(args.limit, 1, 100, 25);
  parts.push(LOT_SELECT, 'order=closes_at.asc', `limit=${overFetch(limit)}`);
  const rows = dedupeStorefronts(await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'))).slice(0, limit);
  const now = Date.now();
  return {
    count: rows.length,
    lots: rows.map((r) => ({
      ...shapeLot(r),
      hours_remaining: r.closes_at ? Math.round(((new Date(r.closes_at).getTime() - now) / 3600_000) * 10) / 10 : null,
    })),
  };
}

function eventFilters(args: Record<string, unknown>): string[] {
  const parts = ['status=eq.active'];
  parts.push(...ftsParts(args));
  parts.push(...housePart(args));
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);
  const minLots = Number(args.min_lots);
  if (Number.isFinite(minLots) && minLots > 0) parts.push(`lot_count=gte.${Math.trunc(minLots)}`);
  return parts;
}

function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function events(cfg: SupabaseConfig, args: Record<string, unknown>) {
  const parts = eventFilters(args);
  // Default floor is today, not now: closes_on is a local calendar date, so a
  // sale closing later today is still live no matter what UTC says.
  const after = isoDate(args.closes_after) ?? new Date().toISOString().slice(0, 10);
  parts.push(`closes_on=gte.${after}`);
  const before = isoDate(args.closes_before);
  if (before) parts.push(`closes_on=lte.${before}`);
  const limit = clampInt(args.limit, 1, 100, 25);
  parts.push(EVENT_SELECT, 'order=closes_on.asc', `limit=${limit}`);
  let rows = await pg<EventRow[]>(cfg, 'auction_events', parts.join('&'));
  if (rows.length === 0 && keywordOf(args)) {
    const fallback = parts
      .filter((p) => !p.startsWith('search_tsv='))
      .concat(substringParts(args));
    rows = await pg<EventRow[]>(cfg, 'auction_events', fallback.join('&'));
  }
  if (rows.length === 0) {
    return {
      error: 'no_events',
      message: `No open auction events match those filters. Auction events currently come from commercial auction houses (HiBid); government surplus sources list individual lots rather than sales — search those with us_auctions_search.`,
    };
  }
  return { count: rows.length, events: rows.map(shapeEvent) };
}

async function houses(cfg: SupabaseConfig, args: Record<string, unknown>) {
  // Rolled up in the pack, not the database: aggregate functions and `group=`
  // are disabled on this project (PGRST123). The open-sale set is small (~2k
  // rows), so pulling it and grouping here is cheap and exact — as opposed to
  // guessing from a sampled page, which would rank houses by luck.
  const parts = eventFilters(args);
  parts.push('closes_on=gte.' + new Date().toISOString().slice(0, 10));
  parts.push('select=auction_house,house_url,location_state,lot_count', 'order=lot_count.desc', 'limit=2000');
  const rows = await pg<Array<Pick<EventRow, 'auction_house' | 'house_url' | 'location_state' | 'lot_count'>>>(
    cfg,
    'auction_events',
    parts.join('&'),
  );

  const byHouse = new Map<string, { auction_house: string; house_url: string | null; states: Set<string>; open_sales: number; live_lots: number }>();
  for (const r of rows) {
    const name = (r.auction_house ?? '').trim();
    if (!name) continue;
    const cur = byHouse.get(name) ?? { auction_house: name, house_url: r.house_url ?? null, states: new Set<string>(), open_sales: 0, live_lots: 0 };
    cur.open_sales += 1;
    cur.live_lots += r.lot_count ?? 0;
    if (r.location_state) cur.states.add(r.location_state);
    if (!cur.house_url && r.house_url) cur.house_url = r.house_url;
    byHouse.set(name, cur);
  }

  const limit = clampInt(args.limit, 1, 100, 25);
  const ranked = [...byHouse.values()].sort((a, b) => b.live_lots - a.live_lots).slice(0, limit);
  if (ranked.length === 0) {
    return { error: 'no_houses', message: 'No auction houses match those filters among currently open sales.' };
  }
  return {
    count: ranked.length,
    houses_seen: byHouse.size,
    houses: ranked.map((h) => ({
      auction_house: h.auction_house,
      house_url: h.house_url,
      states: [...h.states].sort(),
      open_sales: h.open_sales,
      live_lots: h.live_lots,
    })),
  };
}

async function soldComps(cfg: SupabaseConfig, args: Record<string, unknown>) {
  // final_price > 0, not merely not-null: the close-out sweep freezes
  // final_price from the last known bid, and a commercial lot that drew no bids
  // freezes at zero. Counting those as comps would drag every median toward $0
  // and the answer would still look perfectly well-formed.
  const parts = ['status=eq.closed', 'final_price=gt.0'];
  const keyword = keywordOf(args);
  parts.push(...ftsParts(args));
  parts.push(...segmentPart(args));
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);

  const statRows = await pg<Array<{ final_price: number }>>(
    cfg,
    'auction_lots',
    [...parts, 'select=final_price', 'order=closes_at.desc', 'limit=1000'].join('&'),
  );
  if (statRows.length === 0) {
    return {
      error: 'no_comps',
      message: `No closed lots with a recorded sale price match${keyword ? ` "${keyword}"` : ''} yet. Sold-price history accumulates as live lots close.`,
    };
  }
  const prices = statRows.map((r) => Number(r.final_price)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const avg = Math.round(prices.reduce((s, n) => s + n, 0) / prices.length);
  const exLimit = clampInt(args.limit, 1, 50, 10);
  const examples = dedupeStorefronts(
    await pg<Array<LotRow & { source: string; source_lot_id: string }>>(
      cfg,
      'auction_lots',
      [...parts, 'select=source,source_lot_id,title,segment,location_state,auction_house,final_price,closes_at,url', 'order=closes_at.desc', `limit=${overFetch(exLimit)}`].join('&'),
    ),
  ).slice(0, exLimit);
  return {
    matched_lots: prices.length,
    sampled: prices.length >= 1000 ? 'most recent 1,000 matching sales' : 'all matching sales',
    final_price: { min: prices[0], median, average: avg, max: prices[prices.length - 1], currency: 'USD' },
    recent_examples: examples.map((r) => ({
      title: r.title,
      segment: r.segment,
      state: r.location_state,
      auction_house: r.auction_house,
      sold_for: r.final_price,
      closed_at: r.closes_at,
      url: r.url,
    })),
  };
}

async function coverage(cfg: SupabaseConfig) {
  const freshnessRows = await pg<Array<{ source: string; last_success_at: string | null }>>(
    cfg,
    'auction_sources',
    'select=source,last_success_at&limit=200',
  );
  const freshness = new Map(freshnessRows.map((s) => [s.source, s.last_success_at]));

  const perSource = await Promise.all(
    SOURCES.map(async (s) => ({
      source: s.source,
      segment: s.segment,
      description: s.label,
      active_lots: await pgCount(cfg, 'auction_lots', `status=eq.active&source=eq.${s.source}`),
      last_refreshed_at: freshness.get(s.source) ?? null,
    })),
  );

  const [openEvents, soldComps, distinct] = await Promise.all([
    pgCount(cfg, 'auction_events', 'status=eq.active'),
    pgCount(cfg, 'auction_lots', 'status=eq.closed&final_price=gt.0'),
    // GovDeals and AllSurplus are two storefronts over one catalogue, so the
    // per-source counts sum to more lots than exist. Reporting only the sum
    // would overstate coverage by ~47%, and it did until this was added.
    //
    // The catch returns a REASON, not an empty array. It used to swallow the
    // error and report distinct_active_lots: null, and that is exactly how the
    // RPC timing out at 564k rows (57014) went unnoticed — a coverage tool
    // silently omitting its headline number reads as "not implemented yet"
    // rather than "broken". A null with no explanation is the failure mode this
    // whole pack exists to avoid.
    rpc<Array<{ total_rows: number; duplicate_rows: number; distinct_lots: number }>>(
      cfg,
      'auction_distinct_active_count',
      {},
    ).then((r) => ({ ok: true as const, rows: r }))
      .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
  ]);

  const totalActive = perSource.reduce((s, c) => s + c.active_lots, 0);
  const d = distinct.ok ? distinct.rows[0] : undefined;
  return {
    distinct_active_lots: d?.distinct_lots ?? null,
    ...(distinct.ok
      ? {}
      : {
          distinct_active_lots_unavailable:
            `Could not compute the de-duplicated lot count: ${distinct.error.slice(0, 160)}. ` +
            `total_active_lots below counts GovDeals and AllSurplus rows separately and therefore ` +
            `OVERSTATES the number of distinct items — treat it as an upper bound.`,
        }),
    total_active_lots: totalActive,
    cross_listed_lots: d?.duplicate_rows ?? null,
    commercial_lots: perSource.filter((s) => s.segment === 'commercial').reduce((s, c) => s + c.active_lots, 0),
    government_lots: perSource.filter((s) => s.segment === 'government').reduce((s, c) => s + c.active_lots, 0),
    open_auction_events: openEvents,
    sold_comps_retained: soldComps,
    sources: perSource,
    note: 'Commercial sources refresh every ~6 hours; government sources daily. GovDeals and AllSurplus are two storefronts over one catalogue, so per-source counts overlap — distinct_active_lots is the real number of items, and search results are de-duplicated. Closed lots are retained indefinitely, which is why sold prices are answerable at all; the auction sites themselves do not keep them.',
  };
}

// Credentials arrive as injected args, not env — the gateway pack entry sets
// injectSupabase: true and passes _supabaseUrl/_supabaseKey per call.
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = (args._supabaseUrl as string | undefined)?.trim();
  const supabaseKey = (args._supabaseKey as string | undefined)?.trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('us-auctions is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  }
  const cfg: SupabaseConfig = { url: supabaseUrl, key: supabaseKey };
  switch (name) {
    case 'us_auctions_search':
      return search(cfg, args);
    case 'us_auctions_closing_soon':
      return closingSoon(cfg, args);
    case 'us_auction_events':
      return events(cfg, args);
    case 'us_auction_houses':
      return houses(cfg, args);
    case 'us_auctions_sold_comps':
      return soldComps(cfg, args);
    case 'us_auctions_coverage':
      return coverage(cfg);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
