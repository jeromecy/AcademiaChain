// AcademiaChain — author autocomplete proxy
//
// GET /api/autocomplete/authors?q=partial+name
// Optional credential headers (from the frontend Credentials Center):
//   x-user-api-key  — the user's own OpenAlex API key
//   x-user-email    — the user's academic email (polite pool)
//
// Proxies OpenAlex's purpose-built autocomplete endpoint (fast, typo-tolerant)
// and trims the payload to what the dropdown needs. Going through our own
// serverless function keeps credential handling server-side and consistent.
//
// Gotcha handled here: many canonical OpenAlex author records use the Unicode
// hyphen U+2010 in display names (e.g. "Hans‐Peter Piepho"), so a query typed
// with an ASCII hyphen misses them in prefix matching. For hyphenated queries
// we fire a second variant with hyphens as spaces, merge, and re-rank by
// name-token coverage then works_count — canonical (prolific) records first.

export const dynamic = 'force-dynamic';

// Same priority routing as /api/search: user key → user email → server env.
function resolveCreds(userApiKey, userEmail) {
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

function oaHeaders(creds) {
  const mail = creds?.mail || 'academiachain@example.com';
  return {
    'User-Agent': `AcademiaChain/2.0 (mailto:${mail})`,
    Accept: 'application/json',
  };
}

// Lowercase, strip diacritics, fold all hyphen variants (ASCII + U+2010…U+2015)
// into spaces, so "Hans-Peter" == "Hans‐Peter" == "hans peter".
function normalize(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[-‐-―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function autocomplete(q, creds) {
  const url = new URL('https://api.openalex.org/autocomplete/authors');
  url.searchParams.set('q', q);
  if (creds.apiKey) url.searchParams.set('api_key', creds.apiKey);
  if (creds.mail) url.searchParams.set('mailto', creds.mail);
  const res = await fetch(url, {
    headers: oaHeaders(creds),
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  return (await res.json()).results ?? [];
}

export async function GET(request) {
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length < 2) return Response.json({ results: [] });

  const creds = resolveCreds(
    request.headers.get('x-user-api-key'),
    request.headers.get('x-user-email')
  );

  try {
    const variants = [q];
    const dehyphenated = q.replace(/[-‐-―]/g, ' ').replace(/\s+/g, ' ').trim();
    if (dehyphenated !== q) variants.push(dehyphenated);

    const batches = await Promise.all(
      variants.map((v) => autocomplete(v, creds).catch(() => []))
    );

    // Merge by id, then rank: query-token coverage first, works_count second.
    const merged = new Map();
    for (const r of batches.flat()) {
      if (r.id && !merged.has(r.id)) merged.set(r.id, r);
    }
    const tokens = normalize(q).split(' ').filter(Boolean);
    const coverage = (r) => {
      const dn = normalize(r.display_name);
      return tokens.filter((t) => dn.includes(t)).length / tokens.length;
    };
    const ranked = [...merged.values()].sort(
      (x, y) => coverage(y) - coverage(x) || (y.works_count ?? 0) - (x.works_count ?? 0)
    );

    const results = ranked.slice(0, 8).map((r) => ({
      id: r.id.replace('https://openalex.org/', ''),
      name: r.display_name,
      hint: r.hint ?? null, // last known institution
      worksCount: r.works_count ?? null,
    }));

    return Response.json(
      { results },
      // identical prefixes are common while typing — let the CDN absorb them
      { headers: { 'Cache-Control': 'public, max-age=300' } }
    );
  } catch (err) {
    console.error('[api/autocomplete/authors]', err);
    return Response.json({ results: [] });
  }
}
