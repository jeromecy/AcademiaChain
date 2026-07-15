// AcademiaChain — advanced author disambiguation search
//
// GET /api/authors/search?q=name&institution=keyword
// Optional credential headers (from the frontend Credentials Center):
//   x-user-api-key / x-user-email
//
// Full-index author search for when the autocomplete's popularity-ranked
// prefix matching misses younger scholars or common names. Institution
// filtering is two-step, because OpenAlex has no
// `last_known_institutions.display_name.search` filter (returns HTTP 400):
//   1. resolve the keyword via /institutions?search=…  → top institution IDs
//   2. filter authors with affiliations.institution.id:ID1|ID2|ID3
// `affiliations.institution.id` covers every career affiliation, which beats
// last-known-only filtering for scholars who have moved.

export const dynamic = 'force-dynamic';

const OPENALEX = 'https://api.openalex.org';

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

async function oaFetch(path, params, creds) {
  const url = new URL(`${OPENALEX}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (creds.apiKey) url.searchParams.set('api_key', creds.apiKey);
  if (creds.mail) url.searchParams.set('mailto', creds.mail);

  const res = await fetch(url, {
    headers: {
      'User-Agent': `AcademiaChain/2.0 (mailto:${creds.mail ?? 'academiachain@example.com'})`,
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`OpenAlex API error: ${res.status}`);
  return res.json();
}

const shortId = (id) => (id ? id.replace('https://openalex.org/', '') : null);

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').trim();
  const institution = (searchParams.get('institution') ?? '').trim();
  if (q.length < 2) {
    return Response.json({ error: 'Query must be at least 2 characters' }, { status: 400 });
  }

  const creds = resolveCreds(
    request.headers.get('x-user-api-key'),
    request.headers.get('x-user-email')
  );

  try {
    // Step 1 (optional): resolve the institution keyword to OpenAlex IDs
    let institutionIds = [];
    let institutionMatches = [];
    if (institution) {
      const inst = await oaFetch(
        '/institutions',
        { search: institution, 'per-page': '3', select: 'id,display_name,country_code' },
        creds
      );
      institutionMatches = (inst.results ?? []).map((r) => ({
        id: shortId(r.id),
        name: r.display_name,
        country: r.country_code ?? null,
      }));
      institutionIds = institutionMatches.map((r) => r.id);
      if (institutionIds.length === 0) {
        return Response.json({
          results: [],
          note: `No institution on OpenAlex matched "${institution}" — try a shorter keyword.`,
        });
      }
    }

    // Step 2: full author search, optionally scoped to those institutions
    const params = {
      search: q,
      'per-page': '10',
      select: 'id,display_name,works_count,cited_by_count,last_known_institutions,x_concepts',
    };
    if (institutionIds.length > 0) {
      params.filter = `affiliations.institution.id:${institutionIds.join('|')}`;
    }
    const data = await oaFetch('/authors', params, creds);

    const results = (data.results ?? []).map((a) => {
      const inst = a.last_known_institutions?.[0] ?? null;
      return {
        id: shortId(a.id),
        name: a.display_name,
        institution: inst?.display_name ?? null,
        country: inst?.country_code ?? null,
        worksCount: a.works_count ?? 0,
        citedByCount: a.cited_by_count ?? 0,
        // top 2 research-field tags, shown as gray badges in the UI
        concepts: (a.x_concepts ?? []).slice(0, 2).map((c) => c.display_name),
      };
    });

    return Response.json({ results, institutionMatches });
  } catch (err) {
    console.error('[api/authors/search]', err);
    return Response.json({ error: `Advanced search failed: ${err.message}` }, { status: 502 });
  }
}
