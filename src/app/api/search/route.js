// AcademiaChain — co-authorship path search API (v2, streaming)
//
// POST /api/search  { authorA: "name", authorB: "name",
//                     authorAId?: "A123…", authorBId?: "A456…" }
// When the frontend autocomplete has locked in OpenAlex IDs, they are passed
// directly and the fuzzy name-search / disambiguation step is skipped.
//
// Responds with a Server-Sent-Events style stream (text/event-stream).
// Each event is `data: {json}\n\n` with a `state` field, e.g.:
//   resolving_authors, searching_source_level_1, searching_target_level_1,
//   colliding, path_found / not_found / timeout, done (carries the result), error
//
// Algorithm: bidirectional BFS over the OpenAlex co-authorship graph.
// OpenAlex has no "co-authors" endpoint, so expanding a node means fetching
// that author's top-cited works (/works?filter=author.id:X) and extracting
// co-authors from the `authorships` field.
//
// Performance guards (Netlify free tier has a hard 10s function timeout):
//   - MAX_DEPTH:            path length capped at 4 hops (A→B→C→D→E)
//   - WORKS_PER_AUTHOR:     only the 10 most recent works per author
//   - MAX_AUTHORS_PER_WORK: works with more than 8 authors are skipped
//                           entirely (mega-collaborations explode the tree)
//   - concurrency limiter + inter-batch delay + 429 retry (rate-limit safety)
//   - module-level in-memory cache for co-author lookups (warm across requests)
//   - TIME_BUDGET_MS with per-fetch AbortSignal tied to the remaining budget

export const dynamic = 'force-dynamic';

const OPENALEX = 'https://api.openalex.org';

const TIME_BUDGET_MS = Number(process.env.SEARCH_TIME_BUDGET_MS ?? 8500);
const MAX_DEPTH = 4;             // max path length in hops (degrees)
const FRONTIER_CAP = 12;         // authors expanded per BFS level
const WORKS_PER_AUTHOR = 20;     // most recent works fetched per author
const MAX_AUTHORS_PER_WORK = 15;  // skip works with more co-authors than this
const CONCURRENCY = 6;           // parallel OpenAlex requests
const BATCH_DELAY_MS = 100;      // pause between request batches
const CACHE_MAX = 500;           // cached co-author lists (FIFO eviction)

// ---------------------------------------------------------------------------
// Rate limiting: a p-limit style semaphore + simple delay helper + 429 retry
// ---------------------------------------------------------------------------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    if (queue.length) queue.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          release();
        }
      };
      if (active < max) run();
      else queue.push(run);
    });
}
const limit = createLimiter(CONCURRENCY);

// ---------------------------------------------------------------------------
// In-memory caches (module scope — survive across warm serverless invocations)
// ---------------------------------------------------------------------------
const coauthorCache = new Map(); // authorId -> Map<coauthorId, info>
const authorCache = new Map();   // normalized name -> resolved author

function cachePut(cache, key, value, max = CACHE_MAX) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

// ---------------------------------------------------------------------------
// Credentials Center: per-request OpenAlex credentials with priority routing.
//   1. user's own API key (frontend localStorage)  → ?api_key=…  (1M calls/day)
//   2. user's academic email                       → mailto + User-Agent (polite pool)
//   3. server env fallback: OPENALEX_API_KEY / OPENALEX_MAIL
// User credentials are used in-memory for the request only — never stored.
// ---------------------------------------------------------------------------
function resolveCreds(userApiKey, userEmail) {
  // printable ASCII only — anything else could smuggle characters into the
  // query string or User-Agent header
  const clean = (s, max) => {
    const v = typeof s === 'string' ? s.trim() : '';
    return v && v.length <= max && /^[\x21-\x7E]+$/.test(v) ? v : null;
  };
  const key = clean(userApiKey, 128);
  const mail = clean(userEmail, 254);
  if (key) return { apiKey: key, mail: mail ?? process.env.OPENALEX_MAIL ?? null };
  if (mail) return { apiKey: null, mail };
  return {
    apiKey: process.env.OPENALEX_API_KEY || null,
    mail: process.env.OPENALEX_MAIL || null,
  };
}

const DEFAULT_CREDS = resolveCreds(null, null);

function oaHeaders(creds) {
  const mail = creds?.mail || 'academiachain@example.com';
  return {
    'User-Agent': `AcademiaChain/2.0 (mailto:${mail})`,
    Accept: 'application/json',
  };
}

async function oaFetch(path, params = {}, timeoutMs = 6000, creds = DEFAULT_CREDS) {
  const url = new URL(`${OPENALEX}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (creds.apiKey) url.searchParams.set('api_key', creds.apiKey);
  if (creds.mail) url.searchParams.set('mailto', creds.mail);

  return limit(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        headers: oaHeaders(creds),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        await delay(400 * (attempt + 1)); // back off, then retry
        continue;
      }
      if ((res.status === 401 || res.status === 403) && creds.apiKey) {
        throw new Error(
          `OpenAlex rejected the configured API key (${res.status}) — check it in API & Email Settings`
        );
      }
      if (!res.ok) throw new Error(`OpenAlex API error: ${res.status} ${res.statusText}`);
      return res.json();
    }
    throw new Error('OpenAlex rate limit (429) — retries exhausted');
  });
}

const shortId = (id) => (id ? id.replace('https://openalex.org/', '') : null);

// Lowercase, strip diacritics, fold hyphen variants (ASCII + U+2010…U+2015)
// into spaces — canonical OpenAlex names often use the Unicode hyphen U+2010
// ("Hans‐Peter Piepho"), which an ASCII-hyphen query would never match.
function normalize(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[-‐-―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Step 1 — resolve a display name to an OpenAlex author (with disambiguation)
// ---------------------------------------------------------------------------
async function findAuthor(name, creds) {
  const key = name.toLowerCase();
  if (authorCache.has(key)) return authorCache.get(key);

  const data = await oaFetch(
    '/authors',
    {
      search: name,
      'per-page': '5',
      select: 'id,display_name,works_count,last_known_institutions',
    },
    6000,
    creds
  );
  const candidates = data.results ?? [];
  if (candidates.length === 0) return null;

  // OpenAlex search also matches name aliases, which can surface people whose
  // display name barely resembles the query. Score candidates by how many
  // query tokens appear in the (normalized) display name; ties go to the
  // record with more works.
  const tokens = normalize(name).split(' ').filter(Boolean);
  const score = (c) => {
    const dn = normalize(c.display_name);
    return tokens.filter((t) => dn.includes(t)).length / tokens.length;
  };
  const best = candidates.reduce((p, c) => {
    const sp = score(p);
    const sc = score(c);
    if (sc > sp) return c;
    if (sc === sp && (c.works_count ?? 0) > (p.works_count ?? 0)) return c;
    return p;
  });

  const author = {
    id: shortId(best.id),
    name: best.display_name,
    worksCount: best.works_count,
    institution: best.last_known_institutions?.[0]?.display_name ?? null,
  };
  cachePut(authorCache, key, author, 200);
  return author;
}

// Resolve an author directly by OpenAlex ID (autocomplete already locked it in)
async function getAuthorById(id, creds) {
  const key = `id:${id}`;
  if (authorCache.has(key)) return authorCache.get(key);

  const a = await oaFetch(
    `/authors/${id}`,
    { select: 'id,display_name,works_count,last_known_institutions' },
    6000,
    creds
  );
  const author = {
    id: shortId(a.id),
    name: a.display_name,
    worksCount: a.works_count,
    institution: a.last_known_institutions?.[0]?.display_name ?? null,
  };
  cachePut(authorCache, key, author, 200);
  return author;
}

// ---------------------------------------------------------------------------
// Get an author's co-authors from their most recent works (hard pruning)
// Returns Map<coauthorId, { name, paper: {title, year, doi}, strength }>
// ---------------------------------------------------------------------------
async function getCoauthors(authorId, deadline, creds) {
  if (coauthorCache.has(authorId)) return coauthorCache.get(authorId);

  // Tie the per-fetch abort to the remaining time budget so a slow request
  // can never drag the whole search past Netlify's hard timeout.
  const remaining = deadline - Date.now();
  if (remaining < 800) throw new Error('time budget exhausted');

  const data = await oaFetch(
    '/works',
    {
      filter: `authorships.author.id:${authorId}`,
      sort: 'publication_date:desc',
      'per-page': String(WORKS_PER_AUTHOR),
      select: 'id,title,doi,publication_year,authorships',
    },
    Math.min(6000, remaining),
    creds
  );

  const coauthors = new Map();
  for (const work of data.results ?? []) {
    const authorships = work.authorships ?? [];
    // Hard degree pruning: guest-authored mega-collaborations (8+ authors)
    // contribute weak links but explode the search tree — skip them outright.
    if (authorships.length > MAX_AUTHORS_PER_WORK) continue;

    const paper = {
      title: work.title ?? '(untitled)',
      year: work.publication_year ?? null,
      doi: work.doi ?? null,
    };
    for (const as of authorships) {
      const cid = shortId(as.author?.id);
      if (!cid || cid === authorId) continue;
      const existing = coauthors.get(cid);
      if (existing) {
        existing.strength += 1; // strength = number of shared papers
        if (existing.papers.length < 5) existing.papers.push(paper);
      } else {
        coauthors.set(cid, {
          name: as.author.display_name,
          paper,           // first (most recent) shared work — kept for compat
          papers: [paper], // up to 5 shared works, used for weighted edges
          strength: 1,
        });
      }
    }
  }

  cachePut(coauthorCache, authorId, coauthors);
  return coauthors;
}

// ---------------------------------------------------------------------------
// Bidirectional BFS. visitedA / visitedB: Map<id, { parent, name, paper }>
// where `paper` is the work linking this author to `parent`.
// Emits progress through onProgress({state, message, ...}).
// ---------------------------------------------------------------------------
async function bidirectionalBFS(a, b, deadline, onProgress, creds) {
  if (a.id === b.id) {
    return { chain: [{ id: a.id, name: a.name, paper: null }], apiCalls: 0 };
  }

  const visitedA = new Map([[a.id, { parent: null, name: a.name, paper: null }]]);
  const visitedB = new Map([[b.id, { parent: null, name: b.name, paper: null }]]);
  let frontierA = [a.id];
  let frontierB = [b.id];
  let depthA = 0;
  let depthB = 0;
  let apiCalls = 0;

  // Each expansion adds one hop to that side; cap the combined depth at 4
  // so any path we return is at most 4 degrees (A → B → C → D → E).
  while (depthA + depthB < MAX_DEPTH) {
    const expandA = frontierA.length <= frontierB.length;
    const frontier = expandA ? frontierA : frontierB;
    const visited = expandA ? visitedA : visitedB;
    const other = expandA ? visitedB : visitedA;
    const level = (expandA ? depthA : depthB) + 1;
    const who = expandA ? a : b;

    if (frontier.length === 0) return { notFound: true, apiCalls };

    onProgress({
      state: expandA ? `searching_source_level_${level}` : `searching_target_level_${level}`,
      message: expandA
        ? `Expanding level-${level} collaborators of ${who.name}…`
        : `Reverse-expanding level-${level} collaborators of ${who.name}…`,
    });

    const toExpand = frontier.slice(0, FRONTIER_CAP);
    const nextCandidates = [];
    let discovered = 0;

    for (let i = 0; i < toExpand.length; i += CONCURRENCY) {
      if (Date.now() > deadline) return { timeout: true, apiCalls };
      if (i > 0) await delay(BATCH_DELAY_MS); // pace batches, stay under rate limits

      const chunk = toExpand.slice(i, i + CONCURRENCY);
      apiCalls += chunk.length;
      const results = await Promise.all(
        chunk.map((id) => getCoauthors(id, deadline, creds).catch(() => new Map()))
      );

      for (let j = 0; j < chunk.length; j++) {
        const fromId = chunk[j];
        for (const [cid, info] of results[j]) {
          if (visited.has(cid)) continue;
          visited.set(cid, {
            parent: fromId,
            name: info.name,
            paper: info.paper,
            papers: info.papers,
            weight: info.strength,
          });
          discovered++;
          if (other.has(cid)) {
            onProgress({ state: 'path_found', message: 'Connection path found!' });
            return { chain: buildChain(cid, visitedA, visitedB), apiCalls };
          }
          nextCandidates.push({ id: cid, strength: info.strength ?? 1 });
        }
      }
    }

    onProgress({
      state: 'colliding',
      message: `Level ${level} (${expandA ? 'source' : 'target'} side): ${discovered} new collaborators mapped — checking for a frontier collision…`,
    });

    // Expand strong (frequent) collaborators first — they are network hubs.
    nextCandidates.sort((x, y) => y.strength - x.strength);
    if (expandA) {
      frontierA = nextCandidates.map((c) => c.id);
      depthA++;
    } else {
      frontierB = nextCandidates.map((c) => c.id);
      depthB++;
    }
  }

  return { notFound: true, apiCalls };
}

// Walk parent pointers from the meeting node out to both endpoints.
// Returns [{ id, name, paper, papers, weight }] where `paper`/`papers` link
// each author to the PREVIOUS element (`weight` = number of shared works
// among the sampled ones); the first element (author A) carries null links.
function buildChain(meetId, visitedA, visitedB) {
  const left = [];
  let cur = meetId;
  while (cur) {
    const node = visitedA.get(cur);
    left.push({
      id: cur,
      name: node.name,
      paper: node.paper,
      papers: node.papers ?? null,
      weight: node.weight ?? null,
    });
    cur = node.parent;
  }
  left.reverse(); // now A → … → meet

  const right = [];
  let node = visitedB.get(meetId);
  let link = { paper: node.paper, papers: node.papers ?? null, weight: node.weight ?? null };
  cur = node.parent;
  while (cur) {
    const n = visitedB.get(cur);
    right.push({ id: cur, name: n.name, ...link });
    link = { paper: n.paper, papers: n.papers ?? null, weight: n.weight ?? null };
    cur = n.parent;
  }

  return [...left, ...right];
}

// ---------------------------------------------------------------------------
// Route entry — streams SSE progress events, then a final `done` event
// ---------------------------------------------------------------------------
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const authorA = (body.authorA ?? '').trim();
  const authorB = (body.authorB ?? '').trim();
  const authorAId = (body.authorAId ?? '').trim() || null;
  const authorBId = (body.authorBId ?? '').trim() || null;
  if ((!authorA && !authorAId) || (!authorB && !authorBId)) {
    return Response.json({ error: 'Both authorA and authorB are required' }, { status: 400 });
  }

  // Credentials Center: the user's own key/email (from browser localStorage)
  // takes priority over the server's env credentials for every OpenAlex call.
  const creds = resolveCreds(body.userApiKey, body.userEmail);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));

      const started = Date.now();
      const deadline = started + TIME_BUDGET_MS;

      try {
        send({ state: 'resolving_authors', message: 'Resolving author identities on OpenAlex…' });

        // Prefer exact IDs locked in by the autocomplete; fall back to fuzzy
        // name search with disambiguation scoring.
        // Real API errors (bad key, rate limit) propagate to the outer catch
        // with their true message; only a genuine empty result means "not found".
        const [a, b] = await Promise.all([
          authorAId ? getAuthorById(authorAId, creds) : findAuthor(authorA, creds),
          authorBId ? getAuthorById(authorBId, creds) : findAuthor(authorB, creds),
        ]);
        if (!a || !b) {
          send({
            state: 'error',
            message: `Could not find "${!a ? authorA || authorAId : authorB || authorBId}" on OpenAlex. Try the full name or an English spelling.`,
          });
          controller.close();
          return;
        }

        send({
          state: 'authors_resolved',
          message: `Locked in: ${a.name}${a.institution ? ` (${a.institution})` : ''} ⇄ ${b.name}${b.institution ? ` (${b.institution})` : ''}`,
          authorA: a,
          authorB: b,
        });

        const result = await bidirectionalBFS(a, b, deadline, send, creds);
        const elapsedMs = Date.now() - started;

        if (result.chain) {
          send({
            state: 'done',
            found: true,
            result: {
              found: true,
              degrees: result.chain.length - 1,
              authorA: a,
              authorB: b,
              chain: result.chain,
              meta: { elapsedMs, apiCalls: result.apiCalls ?? 0 },
            },
          });
        } else {
          send({
            state: result.timeout ? 'timeout' : 'not_found',
            message: result.timeout
              ? 'Search time budget exhausted — the two scholars are far apart in the collaboration network.'
              : `No connection found within ${MAX_DEPTH} degrees of co-authorship.`,
          });
          send({
            state: 'done',
            found: false,
            result: {
              found: false,
              authorA: a,
              authorB: b,
              reason: result.timeout
                ? 'Timed out before a path emerged. They may still be connected — just beyond what fits in the time budget.'
                : `No connection path found within ${MAX_DEPTH} degrees of co-authorship.`,
              meta: { elapsedMs, apiCalls: result.apiCalls ?? 0 },
            },
          });
        }
      } catch (err) {
        console.error('[api/search]', err);
        send({ state: 'error', message: `Search failed: ${err.message ?? 'unknown error'}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
