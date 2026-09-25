interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
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
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'US Auctions');
}

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
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
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
// Returns null, never 0, when the count cannot be computed.
//
// This used to `return 0` on a non-ok response, and the failure it hid was not
// hypothetical: on 2026-09-01 us_auctions_coverage reported `active_lots: 0` for
// hibid, govdeals, allsurplus AND publicsurplus, plus `sold_comps_retained: 0` —
// while us_auctions_closing_soon was happily returning live HiBid lots from the
// same table. `count=exact` makes Postgres count every matching row, and past a
// few hundred thousand that exceeds the 8 s statement timeout (57014). The four
// biggest sources are exactly the ones whose counts fail, so the tool read as
// "the four sources that matter are empty and we have retained no comps at all",
// which is the most alarming thing it could have said and was false.
//
// A count that failed and a count that is genuinely zero are different facts and
// must not share a representation. Callers render null as "unavailable".
async function pgCount(cfg: SupabaseConfig, table: string, query: string): Promise<number | null> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}&limit=1`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Prefer: 'count=exact' },
  });
  if (!res.ok) return null;
  const range = res.headers.get('content-range') ?? '';
  const n = Number(range.split('/')[1]);
  return Number.isFinite(n) ? n : null;
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
  // Added 2026-09-02: all three were in the scraper's ALL_SOURCES and missing
  // here, so coverage omitted them entirely — the same drift this comment warns
  // about, in the pack that wrote the warning. westauction has live rows right
  // now (us_auctions_search source=westauction returns them); municibid is
  // genuinely at 0 active; purplewave could not be counted at the time of the
  // change. Compare against ALL_SOURCES, not against the gov pack's list.
  { source: 'westauction', segment: 'commercial', label: 'West Auctions — NorCal industrial & agricultural liquidations' },
  { source: 'purplewave', segment: 'commercial', label: 'Purple Wave — Midwest farm, construction & fleet' },
  { source: 'municibid', segment: 'government', label: 'Municibid — town, school district & fire company surplus' },
  // Added 2026-09-05 with the adapter itself, in the same push — the drift this
  // comment warns about happens when the two land separately.
  { source: 'kbid', segment: 'commercial', label: 'K-BID — Minnesota & upper-Midwest affiliate auction companies' },
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

/**
 * The floor on the LIMIT a KEYWORD search sends to Postgres. It is a query PLAN
 * control, not a paging choice, and it is the fix for fleet #1076 — the bug
 * that survived five sessions and four migration files.
 *
 * auction_lots has two viable plans for "active lots matching K, soonest first":
 * walk auction_lots_status_closes_idx in closes_at order and test the tsvector
 * as a row filter, or bitmap the partial GIN and top-N sort the matches. The
 * planner picks between them on the LIMIT, and it picks WRONG below ~11 rows,
 * because early-stop is priced assuming matches are spread evenly through the
 * closes_at ordering. They are not: forklift lots cluster late, so a walk that
 * "should" have stopped after 1,588 index rows read 43,447 of them.
 *
 * overFetch() turns a caller's limit:3 into LIMIT 6, which lands under that
 * crossover, which is why the pack's own examples were the calls that failed.
 * Measured on prod 2026-09-02 (scripts/sql/auction-lots-limit-crossover.sql):
 *
 *   keyword     LIMIT 6/8         LIMIT 200
 *   forklift    7,025 / 8,437 ms  17.7 / 4.3 ms  <- crossover is between 8 and 12
 *   zamboni     (same shape)       2.2 ms
 *   gold        4.7 ms @50        11.9 / 58 ms   <- stays on the btree, correctly
 *   ring        —                  1,388 ms      <- worst case, 6x under the 8s cap
 *
 * Two numbers where there are two: the same query re-measured minutes apart.
 * That spread is buffer residency, and it is worth seeing, because it is what
 * five sessions mistook for the bug. It moves a good plan between 4ms and 58ms.
 * It moved the BAD plan between 101ms and 8,437ms, which is the whole story:
 * warmth decided whether the wrong plan was survivable, never which plan ran.
 *
 * WHY A FLOOR AND NOT A HINT. The floor does not overrule the planner; it moves
 * the query to where the planner is right. A common keyword like `gold` still
 * takes the btree at LIMIT 200 and still answers in 12ms, because for a term
 * with 38,559 live matches early-stop genuinely is cheaper. Only terms rare
 * enough for the walk to be a disaster get pushed onto the bitmap.
 *
 * WHY NOT FORCE THE BITMAP, which is the obvious alternative: measured, it is
 * catastrophic. Denying the btree costs `gold` 12,083 ms — a hard gateway
 * timeout — because the bitmap then has to visit all 38,559 matches. Migration
 * 136 predicted this and it is worth keeping the number, since "just use the
 * GIN" is what anyone reading the 57014 will reach for first.
 *
 * DO NOT raise this to "be safe". A higher floor lengthens the walk for every
 * keyword that legitimately stays on the btree, and `ring` is already the worst
 * of those at 1,388 ms. That direction is reasoning from the plan shape, not a
 * measurement — 400 was never run. 200 was chosen because it is above the
 * crossover for any term with under roughly 5,600 matches (solved from the
 * measured bitmap-vs-btree costs, so treat it as an estimate) and because the
 * common terms it leaves on the btree still answer well inside the cap.
 */
const KEYWORD_PLAN_FLOOR = 200;

function fetchFor(args: Record<string, unknown>, limit: number): number {
  return keywordOf(args) ? Math.max(overFetch(limit), KEYWORD_PLAN_FLOOR) : overFetch(limit);
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
/**
 * Equipment HEAD-NOUNS, used to split an unspaced compound.
 *
 * The auction index spells compound equipment nouns both ways and the two
 * spellings are near-disjoint inventory. Measured 2026-09-04 at limit 40, on
 * pairs the pack was NOT yet unioning, so this is the raw behaviour:
 *
 *   lawnmower        0 lots   lawn mower       40   <- unspaced returns NOTHING
 *   airconditioner   1 lot    air conditioner  40
 *   golfcart         4 lots   golf cart        40
 *   wheelbarrow     40 lots   wheel barrow     38   overlap 0
 *   snowblower      36 lots   snow blower      40   overlap 1
 *   chainsaw        40 lots   chain saw        40   overlap 4
 *   flatbed         40 lots   flat bed         40   overlap 1
 *
 * A caller searching "lawnmower" gets zero results while forty sit under
 * "lawn mower". This replaces a hand-curated list of 12 pairs, which was the
 * first version and was plainly inadequate: the phenomenon is general across
 * compound nouns and a list can only ever cover the ones someone thought of.
 * None of the seven above was in it.
 *
 * Splitting before a head-noun needs no dictionary and costs ONE extra query.
 * The >=3-char guard on the first half is what stops nonsense splits — "shoe"
 * does not become "s hoe", and "excavator" and "generator" match nothing here.
 */
const EQUIPMENT_HEADS = [
  'conditioner', 'spreader', 'trailer', 'tractor', 'grinder', 'blower', 'loader',
  'barrow', 'washer', 'heater', 'sander', 'dozer', 'mower', 'press', 'steer',
  'truck', 'drill', 'chair', 'table', 'plow', 'pump', 'tank', 'cart', 'lift',
  'saw', 'box', 'bed', 'hoe',
] as const;

/**
 * The spaced spelling of an unspaced compound keyword, or null.
 *
 * ONE DIRECTION ONLY, deliberately. Unspaced -> spaced RESCUES a query: the
 * spaced form is where the real equipment lives ("Fire Truck" is Pierce and
 * Sutphen; "Firetruck" is Tootsietoy and Matchbox). Going the other way would
 * ADD the collectible half to a query that was already returning real machines,
 * making a good answer worse. The failure being fixed is one-directional, so
 * the fix is too.
 *
 * Only fires on a single-token keyword, so it cannot stack with the
 * relaxed-keyword fallback for multi-word keywords and leave it ambiguous which
 * pass produced a row.
 */
function keywordVariant(keyword: string): string | null {
  const k = keyword.trim().toLowerCase();
  if (!k || /\s/.test(k)) return null;
  for (const head of EQUIPMENT_HEADS) {
    if (k.endsWith(head) && k.length - head.length >= 3) return `${k.slice(0, -head.length)} ${head}`;
  }
  return null;
}

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

/**
 * Canadian province codes. HiBid indexes Canadian auctioneers alongside US
 * ones and the ingest never filtered on country, so a tool called
 * `us_auctions_search`, whose description promises "live US auction lots", was
 * quietly serving them.
 *
 * Found 2026-09-04 from a real answer: "firetrucks up for auction in the US"
 * returned "2002 Spartan Firetruck — Welland, ON" and "2007 Spartan Firetruck —
 * Woodstock, ON" among ten results. Not a stray record either — probing by
 * state found live inventory in ON, BC, AB, QC, MB and NS. Nothing in the
 * response said the lot was Canadian; `location` reads "Welland, ON" and a
 * reader who does not know Ontario from Ohio has no signal at all.
 *
 * None of these codes collides with a US state abbreviation, so excluding them
 * cannot drop US inventory.
 */
const CA_PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;

/**
 * Exclude non-US lots WITHOUT dropping lots that have no state recorded.
 *
 * A bare `location_state=not.in.(…)` evaluates to NULL for a null column and
 * PostgREST drops those rows — which would silently delete every lot whose
 * state the upstream did not publish, trading a wrong-country bug for a
 * missing-inventory one. The explicit `is.null` arm is what stops that, and it
 * is the whole reason this is an `or=` rather than a one-liner.
 */
const US_ONLY_FILTER = `or=(location_state.is.null,location_state.not.in.(${CA_PROVINCES.join(',')}))`;

function activeLotFilters(args: Record<string, unknown>): string[] {
  const parts = ['status=eq.active'];
  parts.push(...ftsParts(args));
  parts.push(...segmentPart(args));
  parts.push(...housePart(args));
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);
  // Applied here rather than at each call site so no query path can forget it:
  // this builder feeds the keyword search, the substring fallback, the relaxed
  // fallback and closing-soon. Skipped when the caller named a state
  // explicitly — that request is already scoped, and layering an exclusion on
  // top would turn `state:"ON"` into a silent zero instead of the honest empty
  // a US-only tool should give.
  if (!state) parts.push(US_ONLY_FILTER);
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const source = String(args.source ?? '').trim().toLowerCase();
  if (source) parts.push(`source=eq.${encodeURIComponent(source)}`);
  return parts;
}

async function rpc<T>(cfg: SupabaseConfig, fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
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
    // Same plan floor as the unbounded path below: closing_within_hours narrows
    // the walk but does not stop the planner early-stopping inside the window,
    // and a caller may pass 720 hours.
    parts.push(LOT_SELECT, 'order=closes_at.asc.nullslast', `limit=${fetchFor(args, limit)}`);
    const rows = (await pg<LotRow[]>(cfg, 'auction_lots', parts.join('&'))).slice(0, limit);
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
  const want = fetchFor(args, limit);
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
  // The index spells compound equipment nouns BOTH ways, and the two spellings
  // are disjoint inventory. Measured 2026-09-04, limit 40 each:
  //
  //   "firetruck"  40 lots   "fire truck"  40 lots   overlap 0
  //   "skidsteer"  26 lots   "skid steer"  40 lots   overlap 0
  //   "dumptruck"   7 lots   "dump truck"  40 lots   overlap 0
  //
  // ZERO overlap in all three. So a caller searching one spelling sees none of
  // the other half, and which half they get is decided by whichever form the
  // asker happened to type. That is not a ranking problem — half the inventory
  // is invisible.
  //
  // It is also how "firetrucks up for auction in the US" came back as toys
  // (Bruce, 2026-09-04). Auction houses title real apparatus "Fire Truck" and
  // list collectibles as "Firetruck", so the one-word spelling is dominated by
  // Tootsietoy and Matchbox while the two-word one is Pierce, Sutphen and
  // Rosenbauer at $510-$60,000. The user meant fire apparatus; the vocabulary
  // split decided otherwise.
  //
  // NOT fixable with asset_type, which was the obvious fix and is wrong:
  // measured on the same rows, the real "1990 Firetruck" is asset_type "other"
  // while the toy "Firetruck, Ambulance, Tow Truck Toys" is "vehicle". The
  // field is unreliable per-row, so filtering on it would have DROPPED the real
  // truck and KEPT the toy. `category` is no help either — it holds the sale's
  // name ("Labor Day Online Auction!!"), not a taxonomy.
  //
  // So: search both spellings and union. Additive by construction — it can only
  // reveal lots that were already matching a form of the caller's own word.
  let rows = dedupeStorefronts(raw).slice(0, limit);
  let variantUsed: string | null = null;
  const variant = keywordVariant(keywordOf(args));
  // NOT gated on the first spelling coming up short, which was the first thing
  // I wrote and it defeated the entire fix: "firetruck" returns 40 toy lots and
  // fills the page, so the union would never have fired on the exact query that
  // motivated it. The two sets are disjoint — a full page of one spelling is
  // precisely when the other half is most invisible.
  if (variant) {
    const vParts = activeLotFilters({ ...args, keyword: variant });
    const vRaw = await pg<LotRow[]>(
      cfg,
      'auction_lots',
      [...vParts, `closes_at=gte.${nowIso}`, LOT_SELECT, 'order=closes_at.asc', `limit=${want}`].join('&'),
    ).catch(() => [] as LotRow[]);
    if (vRaw.length > 0) {
      variantUsed = variant;
      // Re-sort the union rather than appending: both halves are ordered by
      // close time on their own, and a caller reading "soonest first" must not
      // get one list stapled to the end of another.
      rows = dedupeStorefronts(raw.concat(vRaw))
        .sort((a, b) => String(a.closes_at ?? '9999').localeCompare(String(b.closes_at ?? '9999')))
        .slice(0, limit);
    }
  }

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
      [...fallbackParts, `closes_at=gte.${nowIso}`, LOT_SELECT, 'order=closes_at.asc', `limit=${fetchFor(args, limit)}`].join('&'),
    );
    const fb = dedupeStorefronts(fbRaw).slice(0, limit);
    if (fb.length > 0) return { count: fb.length, matched_by: 'partial-word match', lots: fb.map(shapeLot) };

    // Still nothing, and the keyword has several words. Both passes above AND
    // their terms — websearch_to_tsquery ANDs, and substringParts ANDs per
    // token — so a keyword built out of SYNONYMS rather than conjuncts asks for
    // lots that contain all of them at once, and none does.
    //
    // That is not a hypothetical. Asked for "firetrucks (ladder trucks) up for
    // auction in the US" on 2026-09-04, the router filled
    // keyword:"firetruck ladder truck" and got 0 real matches, leaving a single
    // toy lot ("Plastic Firetrucks") as the entire answer to a nationwide
    // question. Each phrase on its own is fine: "ladder truck" 25 lots,
    // "fire truck" 25, "firetruck" 10. Only the concatenation is empty. The
    // caller cannot see any of that — an empty AND is a clean zero.
    //
    // So relax: try the longest contiguous phrases first, then single words,
    // longest first, and take the first that answers. Longest-first matters —
    // "ladder truck" is a better answer than "truck", and trying words first
    // would return every truck on the site and call it a match.
    const kw = keywordOf(args);
    const words = kw.split(/\s+/).filter((w) => /[a-z0-9]{2,}/i.test(w));
    if (words.length > 1) {
      const tried = new Set<string>([kw.toLowerCase()]);
      const attempts: string[] = [];
      for (let size = words.length - 1; size >= 1; size--) {
        for (let i = 0; i + size <= words.length; i++) attempts.push(words.slice(i, i + size).join(' '));
      }
      for (const attempt of attempts) {
        const key = attempt.toLowerCase();
        if (tried.has(key)) continue;
        tried.add(key);
        // Bounded: a 3-word keyword is 5 extra candidates at worst, and we stop
        // at the first that answers. Only reached when the caller was going to
        // get zero anyway, so it can add results but never remove them.
        if (tried.size > 6) break;
        const relaxedParts = activeLotFilters({ ...args, keyword: attempt })
          .filter((p) => !p.startsWith('search_tsv='))
          .concat(ftsParts({ keyword: attempt }));
        const rxRaw = await pg<LotRow[]>(
          cfg,
          'auction_lots',
          [...relaxedParts, `closes_at=gte.${nowIso}`, LOT_SELECT, 'order=closes_at.asc', `limit=${fetchFor(args, limit)}`].join('&'),
        ).catch(() => [] as LotRow[]);
        const rx = dedupeStorefronts(rxRaw).slice(0, limit);
        if (rx.length > 0) {
          return {
            count: rx.length,
            matched_by: 'relaxed keyword',
            keyword_requested: kw,
            keyword_used: attempt,
            // Say it out loud. The caller asked for one thing and is being
            // shown another, and a silent substitution here is the same defect
            // as the silent zero it replaces.
            note: `No lot matched all of "${kw}" — those words were treated as one phrase and AND-ed. These lots match "${attempt}" instead. Search one term at a time for a narrower result.`,
            lots: rx.map(shapeLot),
          };
        }
      }
    }
  }

  return {
    count: rows.length,
    // Say when the union fired. A caller who asked for "firetruck" and is shown
    // "Fire Truck" lots should be able to see why, and an evaluator counting
    // results needs to know two spellings were searched rather than one.
    ...(variantUsed ? { also_searched: variantUsed, note: `The index spells this both ways and the two sets do not overlap, so "${keywordOf(args)}" and "${variantUsed}" were both searched.` } : {}),
    lots: rows.map(shapeLot),
  };
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
  // us_auctions_closing_soon takes a `keyword` too, and it is the same shape
  // that broke us_auctions_search: active + tsvector + ORDER BY closes_at with a
  // small LIMIT. Same floor, same reason — see KEYWORD_PLAN_FLOOR.
  parts.push(LOT_SELECT, 'order=closes_at.asc', `limit=${fetchFor(args, limit)}`);
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
  // Same country leak as the lot search — this tool says "Upcoming US auction
  // EVENTS" and the events table carries Canadian houses too.
  if (!state) parts.push(US_ONLY_FILTER);
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
  // A comp is a sale that HAPPENED. 12% of what this tool was averaging had not.
  //
  // Measured 2026-09-04 over 240 sampled comps across six keywords: 29 of them
  // carried a closes_at in the FUTURE while marked status=closed with a
  // final_price. Concentrated, not scattered — dump truck 13/40 (33%),
  // generator 10/40, tractor 5/40. Real machines: a 2005 Sterling LT8500 at
  // $2,500 closing Sept 16, a 1998 Mack at $7,500 closing Sept 10.
  //
  // Their "final price" is a LIVE BID that has not finished rising, so every
  // one of them drags the median DOWN — systematically, in the one direction
  // that matters for a tool people price against. Nothing in the response said
  // so: a well-formed median, a USD label, and a third of the dump-truck sample
  // mid-auction.
  //
  // Null closes_at is KEPT deliberately. The close-out sweep freezes a final
  // price on lots that vanish upstream without ever carrying a close date;
  // those are genuine completed sales whose date we do not know, and dropping
  // them would trade a wrong number for a smaller one. Same null-safe shape as
  // the country filter above, and for the same reason.
  const parts = ['status=eq.closed', 'final_price=gt.0'];
  const keyword = keywordOf(args);
  parts.push(...ftsParts(args));
  parts.push(...segmentPart(args));
  const assetType = normalizeAssetType(String(args.asset_type ?? args.category ?? '').trim());
  if (assetType) parts.push(`asset_type=eq.${encodeURIComponent(assetType)}`);
  const state = String(args.state ?? args.location_state ?? '').trim();
  if (state) parts.push(`location_state=eq.${encodeURIComponent(state.toUpperCase())}`);
  // TWO null-safe clauses, combined into ONE `and=` rather than two `or=`
  // params. PostgREST takes repeated top-level `or=` ambiguously — one can win
  // and the other vanish with no error, which would silently restore either the
  // Canadian lots or the unfinished auctions while the response still looked
  // perfectly well-formed. Nesting makes it a single unambiguous filter.
  //
  // 1. SETTLED. A comp is a sale that HAPPENED, and 12% of what this tool was
  //    averaging had not. Measured 2026-09-04 over 240 sampled comps across six
  //    keywords: 29 carried a closes_at in the FUTURE while marked
  //    status=closed with a final_price. Concentrated rather than scattered —
  //    dump truck 13/40 (33%), generator 10/40, tractor 5/40. Real machines: a
  //    2005 Sterling LT8500 at $2,500 closing Sept 16, a 1998 Mack at $7,500
  //    closing Sept 10. Their "final price" is a LIVE BID still rising, so each
  //    one drags the median DOWN — systematically, in the one direction that
  //    matters for a number people price against.
  //    Null closes_at is KEPT: the close-out sweep freezes a final price on lots
  //    that vanish upstream without a date, and those are genuine completed
  //    sales. Dropping them would trade a wrong number for a smaller one.
  //
  // 2. US-ONLY. Worst here of anywhere, because a comp is a PRICE and Canadian
  //    hammer prices are in CAD — a stray row moves the median rather than just
  //    sitting there to be ignored. Note `final_price.currency` is asserted as
  //    'USD' further down and never derived from the rows, so nothing downstream
  //    would have caught the mix.
  const settled = `or(closes_at.is.null,closes_at.lte.${new Date().toISOString()})`;
  parts.push(state
    ? `and=(${settled})`
    // Province codes are QUOTED inside the nested `in` list. Unquoted, the
    // commas separating them are read as separators of the ENCLOSING group, so
    // PostgREST parsed the filter as something else entirely and applied
    // neither clause — silently, with a 200 and a well-formed median.
    //
    // Isolated by branch rather than guessed: with `state` set (the simple
    // `and=(settled)` branch, no nested in-list) future-dated comps dropped to
    // ZERO, while the nested branch still leaked them. Same clause, same
    // deploy — so the settled logic was right and only the nesting was wrong.
    : `and=(${settled},or(location_state.is.null,location_state.not.in.(${CA_PROVINCES.map((c) => `"${c}"`).join(',')})))`);

  // `order=closes_at.desc` alone is DESC NULLS FIRST in Postgres, so the "most
  // recent 1,000 matching sales" were in fact 1,000 lots with NO close date at
  // all — the close-out sweep freezes a final price on lots that vanished
  // upstream without ever carrying one. Measured live 2026-09-01: every single
  // recent_example came back `closed_at: null`, and the headline median was
  // computed from that undated bucket rather than from recent sales. A
  // well-formed number describing the wrong rows; nothing errored.
  //
  // Not fixed with `.nullslast`, which would be correct and slow: the partial
  // index is `(closes_at DESC) WHERE status='closed' AND final_price > 0`, whose
  // stored order IS nulls-first, so asking for NULLS LAST cannot be served from
  // it and degrades to a sort over the whole comps set — trading a wrong answer
  // for a timeout. Two index-friendly passes instead, the same shape `search`
  // already uses: dated sales newest-first, topped up with undated ones only if
  // there are fewer than 1,000. `IS NOT NULL` on the leading index column is an
  // index condition, so the first pass still starts at the newest real sale.
  const STAT_LIMIT = 1000;
  const dated = await pg<Array<{ final_price: number }>>(
    cfg,
    'auction_lots',
    [...parts, 'closes_at=not.is.null', 'select=final_price', 'order=closes_at.desc', `limit=${STAT_LIMIT}`].join('&'),
  );
  const statRows =
    dated.length >= STAT_LIMIT
      ? dated
      : dated.concat(
          await pg<Array<{ final_price: number }>>(
            cfg,
            'auction_lots',
            [...parts, 'closes_at=is.null', 'select=final_price', `limit=${STAT_LIMIT - dated.length}`].join('&'),
          ),
        );
  const undatedInSample = statRows.length - dated.length;
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
  const EX_SELECT = 'select=source,source_lot_id,title,segment,location_state,auction_house,final_price,closes_at,url';
  const exWant = fetchFor(args, exLimit);
  const datedEx = await pg<Array<LotRow & { source: string; source_lot_id: string }>>(
    cfg,
    'auction_lots',
    [...parts, 'closes_at=not.is.null', EX_SELECT, 'order=closes_at.desc', `limit=${exWant}`].join('&'),
  );
  const rawEx =
    datedEx.length >= exWant
      ? datedEx
      : datedEx.concat(
          await pg<Array<LotRow & { source: string; source_lot_id: string }>>(
            cfg,
            'auction_lots',
            [...parts, 'closes_at=is.null', EX_SELECT, `limit=${exWant - datedEx.length}`].join('&'),
          ),
        );
  const examples = dedupeStorefronts(rawEx).slice(0, exLimit);
  return {
    matched_lots: prices.length,
    sampled:
      prices.length >= STAT_LIMIT
        ? 'most recent 1,000 matching sales'
        : 'all matching sales',
    ...(undatedInSample > 0
      ? {
          undated_sales_in_sample: undatedInSample,
          undated_sales_note:
            `${undatedInSample} of the ${statRows.length} sales in this sample have no recorded close ` +
            `date — they were closed by the vanished-lot sweep, which freezes the last known price but ` +
            `cannot know when the sale ended. Their prices are real; their recency is unknown.`,
        }
      : {}),
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

  // A source whose count timed out contributes nothing to the sum and is named
  // instead, so the total is explicitly a partial rather than a smaller number
  // presented as a complete one.
  const uncounted = perSource.filter((s) => s.active_lots === null).map((s) => s.source);
  const totalActive = perSource.reduce((s, c) => s + (c.active_lots ?? 0), 0);
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
    ...(uncounted.length
      ? {
          total_active_lots_partial:
            `Counts timed out for ${uncounted.join(', ')} — those sources are NOT empty, they are ` +
            `uncounted, and they contribute 0 to total_active_lots. An exact count over a table this ` +
            `size exceeds the statement timeout. Use us_auctions_search or us_auctions_closing_soon ` +
            `to confirm a source is live.`,
          uncounted_sources: uncounted,
        }
      : {}),
    cross_listed_lots: d?.duplicate_rows ?? null,
    commercial_lots: perSource.filter((s) => s.segment === 'commercial').reduce((s, c) => s + (c.active_lots ?? 0), 0),
    government_lots: perSource.filter((s) => s.segment === 'government').reduce((s, c) => s + (c.active_lots ?? 0), 0),
    open_auction_events: openEvents,
    sold_comps_retained: soldComps,
    ...(soldComps === null
      ? {
          sold_comps_retained_unavailable:
            'The exact count of retained sold comps timed out. Comps ARE retained — call ' +
            'us_auctions_sold_comps to read them. null here means uncounted, not zero.',
        }
      : {}),
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
