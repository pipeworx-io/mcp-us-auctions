# @pipeworx/us-auctions

Live US auction lots from both halves of the market — roughly 1,900 commercial
auction houses and every reachable government surplus, seized and tax-deed
source — searchable by keyword, state or distance from a ZIP, plus the sold
prices auction sites delete when a lot closes.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1481+ live data sources.

## Tools

- `us_auctions_search(keyword?, state?, asset_type?, segment?, source?, auction_house?, near_zip?, radius_miles?, max_price?, closing_within_hours?, limit?)` — the general lot search. Pass `near_zip` and results come back ordered by distance with `distance_miles` on each row.
- `us_auctions_closing_soon(...)` — the same pool ordered by soonest close, with `hours_remaining`. Answers "what can I still bid on".
- `us_auction_events(state?, keyword?, auction_house?, closes_after?, closes_before?, min_lots?, limit?)` — the sales themselves rather than the lots. "What auctions are happening near me next week."
- `us_auction_houses(state?, keyword?, limit?)` — which auctioneers we cover and how much each has live, ranked by lot count. Feed a name back into the two tools above.
- `us_auctions_sold_comps(keyword?, asset_type?, state?, segment?, limit?)` — min / median / average / max realized price plus recent examples. The differentiator.
- `us_auctions_coverage()` — per-source counts, open sale count, retained comps, per-source last-refresh time.

## Auth

Keyless to the caller. The gateway injects the pack's data credentials per call;
the pack itself is stateless and holds no secret.

## Relationship to the neighbouring packs

- `gov-auctions` — the same store filtered to `segment='government'`. Kept
  separate because it is published to npm and the MCP Registry under that
  narrower contract, and a caller asking for surplus pickup trucks must not
  start getting estate-sale antiques.
- `gsa-auctions` — the live GSA federal-surplus API. Not DB-backed, so its lots
  are not in this store and do not appear here.

## Data sources

Ingested by `workers/auction-scraper` (one adapter per source, cursor-resumed
across cron firings). See that worker for the per-source traps.

- `hibid` — commercial. GraphQL, unauthenticated. ~1,900 US auction houses.
- `govdeals`, `allsurplus` — state/local and business surplus. `allsurplus` also
  covers **govliquidation.com** and **go-dove.com**, which are the same catalogue
  served under different domains — do not build adapters for those.
- `publicsurplus`, `bid4assets`, `irs`, `txauction` — the rest of the government
  half.

## Things the next person would otherwise rediscover the hard way

- **Aggregate functions and `group=` are DISABLED on this project (PGRST123).**
  There is no `count()`. Exact counts come from `Prefer: count=exact` and the
  `Content-Range` tail; the per-house rollup in `us_auction_houses` is computed
  in the pack over a bounded row pull, not by the database.
- **`final_price > 0`, never merely `not.is.null`.** The close-out sweep freezes
  `final_price` from the last known bid, and a commercial lot that drew no bids
  freezes at zero. Counting those as comps drags every median toward $0 while the
  response still looks perfectly well-formed.
- **Event dates are LOCAL CALENDAR DATES, not instants.** `closes_on` /
  `starts_on` are dates because HiBid publishes sale times with no timezone.
  Lot-level `closes_at` IS a true instant (derived from a countdown), which is
  why `closing_within_hours` keys off lots and `us_auction_events` off dates.
  Don't "fix" this by parsing the local string — that silently shifts evening
  West-coast sales onto the next day.
- **The unfiltered search is two queries, not one `or=`.** Ordering by
  `closes_at` while OR-ing `closes_at >= now()` with `closes_at IS NULL` cannot
  be served from an index, and on the plainest possible call it scanned the whole
  active pool and blew the 8s statement timeout — alternating between a hard 500
  and a *silent empty result*. The split returns identical rows in identical
  order.
- **Coordinates are ZIP centroids.** Most sources publish a ZIP and nothing
  finer, so a lot's position is its town's position. `distance_miles` is
  town-level; the response says so, and it should keep saying so.
- **Keyword search is full-text first, substring second.** `search_tsv` (a
  weighted stored column, migration 092) stems and reaches the description; the
  trigram `ILIKE` pass only runs when full-text found nothing, because auction
  titles are full of partial model numbers a tsquery cannot match inside a word.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "us-auctions": {
      "url": "https://gateway.pipeworx.io/us-auctions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/us-auctions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1481+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Us Auctions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
