'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as d3 from 'd3';
import { Settings, X } from 'lucide-react';

// Credentials Center — stored ONLY in the browser's localStorage
const LS_API_KEY = 'academiachain_api_key';
const LS_EMAIL = 'academiachain_email';

// Attach the saved credentials to autocomplete requests as headers
function credentialHeaders() {
  if (typeof window === 'undefined') return {};
  const headers = {};
  const key = localStorage.getItem(LS_API_KEY);
  const mail = localStorage.getItem(LS_EMAIL);
  if (key) headers['x-user-api-key'] = key;
  if (mail) headers['x-user-email'] = mail;
  return headers;
}

const STATE_ICONS = {
  resolving_authors: '🔍',
  authors_resolved: '🎯',
  colliding: '💥',
  path_found: '✨',
  timeout: '⏱️',
  not_found: '🕳️',
  error: '⚠️',
};

function iconFor(state) {
  if (STATE_ICONS[state]) return STATE_ICONS[state];
  if (state.startsWith('searching_source')) return '🌐';
  if (state.startsWith('searching_target')) return '🛰️';
  return '·';
}

const EMPTY_AUTHOR = { text: '', selected: null };

export default function Home() {
  const [authorA, setAuthorA] = useState(EMPTY_AUTHOR);
  const [authorB, setAuthorB] = useState(EMPTY_AUTHOR);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState([]); // streamed progress timeline
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showCert, setShowCert] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [email, setEmail] = useState('');

  // Restore saved credentials from localStorage on first load
  useEffect(() => {
    setApiKey(localStorage.getItem(LS_API_KEY) ?? '');
    setEmail(localStorage.getItem(LS_EMAIL) ?? '');
  }, []);

  async function handleSearch(e) {
    e.preventDefault();
    if (!authorA.text.trim() || !authorB.text.trim() || loading) return;

    setLoading(true);
    setResult(null);
    setError(null);
    setShowCert(false);
    setEvents([]);

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorA: authorA.text.trim(),
          authorB: authorB.text.trim(),
          // IDs locked in via autocomplete skip fuzzy matching on the server
          authorAId: authorA.selected?.id ?? null,
          authorBId: authorB.selected?.id ?? null,
          // Credentials Center: user's own quota takes priority server-side
          userApiKey: apiKey.trim() || null,
          userEmail: email.trim() || null,
        }),
      });

      // Validation failures come back as plain JSON, not a stream
      if (!res.ok || res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Request failed (HTTP ${res.status})`);
        return;
      }

      // Parse the SSE stream: events are `data: {json}\n\n`
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          let evt;
          try {
            evt = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }

          if (evt.state === 'done') {
            setResult(evt.result);
          } else if (evt.state === 'error') {
            setError(evt.message);
            setEvents((prev) => [...prev, evt]);
          } else {
            setEvents((prev) => [...prev, evt]);
          }
        }
      }
    } catch (err) {
      setError(`Network error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <header className="hero">
        <div className="logo">🔗</div>
        <h1>
          Academia<span>Chain</span>
        </h1>
        <p>
          Discover the shortest co-authorship path between any two scholars —
          <br />
          your very own Erdős number, computed live on the OpenAlex scholarly graph.
        </p>
      </header>

      <div className="settings-row">
        <button
          type="button"
          className="settings-toggle"
          onClick={() => setShowSettings((s) => !s)}
        >
          <Settings size={15} strokeWidth={2} />
          API &amp; Email Settings
        </button>
      </div>

      {showSettings && (
        <CredentialsPanel
          apiKey={apiKey}
          setApiKey={setApiKey}
          email={email}
          setEmail={setEmail}
          onClose={() => setShowSettings(false)}
        />
      )}

      <form className="search-card" onSubmit={handleSearch}>
        <div className="search-row">
          <AuthorInput
            inputId="authorA"
            label="Scholar A"
            placeholder="e.g. Paul Erdős"
            disabled={loading}
            author={authorA}
            setAuthor={setAuthorA}
          />
          <div className="link-icon">⇄</div>
          <AuthorInput
            inputId="authorB"
            label="Scholar B"
            placeholder="e.g. Terence Tao"
            disabled={loading}
            author={authorB}
            setAuthor={setAuthorB}
          />
        </div>
        <button className="connect-btn" type="submit" disabled={loading}>
          {loading ? 'Traversing the network…' : '⚡ Connect'}
        </button>
        {loading && <div className="progress-bar"><div className="progress-fill" /></div>}
      </form>

      {(loading || events.length > 0) && !result && (
        <Timeline events={events} loading={loading} />
      )}

      {error && <div className="error-box">⚠️ {error}</div>}

      {result && !loading && (
        <>
          <Timeline events={events} loading={false} collapsed />
          {result.found ? (
            <GraphResult result={result} onCertificate={() => setShowCert(true)} />
          ) : (
            <NotFound result={result} />
          )}
        </>
      )}

      {showCert && result?.found && (
        <CertificateModal result={result} onClose={() => setShowCert(false)} />
      )}

      <footer>
        Powered by{' '}
        <a href="https://openalex.org" target="_blank" rel="noreferrer">
          OpenAlex
        </a>{' '}
        · Inspired by the Erdős number
      </footer>
    </main>
  );
}

/* ---------------- Credentials Center ---------------- */

function CredentialsPanel({ apiKey, setApiKey, email, setEmail, onClose }) {
  const [saved, setSaved] = useState(false);

  function handleSave() {
    localStorage.setItem(LS_API_KEY, apiKey.trim());
    localStorage.setItem(LS_EMAIL, email.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <section className="settings-panel">
      <div className="settings-head">
        <h3>🔑 Credentials Center</h3>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>
      </div>

      <div className="field">
        <label htmlFor="oaApiKey">OpenAlex API Key</label>
        <input
          id="oaApiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="For power users — 1,000,000 free calls/day"
          autoComplete="off"
        />
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="oaEmail">Academic Email</label>
        <input
          id="oaEmail"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Joins the polite pool — 100,000 calls/day"
          autoComplete="off"
        />
      </div>

      <button type="button" className="save-btn" onClick={handleSave}>
        {saved ? '✓ Saved locally' : '💾 Save'}
      </button>

      <p className="settings-note">
        Stored only in your browser&apos;s <code>localStorage</code> and sent directly to the
        OpenAlex API — never stored or logged by AcademiaChain. Your key takes priority; the
        email is used for the polite pool when no key is set.
      </p>
    </section>
  );
}

/* ---------------- Autocomplete author input ---------------- */

function AuthorInput({ inputId, label, placeholder, disabled, author, setAuthor }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const debounceTimer = useRef(null);
  const requestSeq = useRef(0); // drop out-of-order responses

  function handleChange(e) {
    const text = e.target.value;
    setAuthor({ text, selected: null }); // typing again invalidates the locked ID
    clearTimeout(debounceTimer.current);

    if (text.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    debounceTimer.current = setTimeout(async () => {
      const seq = ++requestSeq.current;
      try {
        const res = await fetch(
          `/api/autocomplete/authors?q=${encodeURIComponent(text.trim())}`,
          { headers: credentialHeaders() }
        );
        const data = await res.json();
        if (seq !== requestSeq.current) return; // a newer keystroke superseded us
        setSuggestions(data.results ?? []);
        // open even with zero results — the advanced-search entry must stay
        // reachable exactly when the autocomplete fails to find someone
        setOpen(true);
      } catch {
        /* autocomplete is best-effort — plain name search still works */
      }
    }, 300);
  }

  function pick(s) {
    setAuthor({ text: s.name, selected: s });
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        value={author.text}
        onChange={handleChange}
        onFocus={() => author.text.trim().length >= 2 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
      />
      {author.selected && (
        <div className="locked-hint">
          ✓ Locked: {author.selected.hint ?? author.selected.id}
        </div>
      )}
      {open && (
        <ul className="suggestions">
          {suggestions.map((s) => (
            /* onMouseDown + preventDefault so the click wins over input blur */
            <li key={s.id} onMouseDown={(e) => { e.preventDefault(); pick(s); }}>
              <div className="sg-name">{s.name}</div>
              <div className="sg-meta">
                {s.hint ?? 'Unknown affiliation'}
                {s.worksCount != null && <span> · {s.worksCount.toLocaleString()} works</span>}
              </div>
            </li>
          ))}
          {suggestions.length === 0 && (
            <li className="sg-empty">No quick matches for “{author.text.trim()}”</li>
          )}
          <li
            className="sg-adv"
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen(false);
              setAdvOpen(true);
            }}
          >
            🔍 Can&apos;t find your scholar? Open advanced disambiguation
          </li>
        </ul>
      )}
      {advOpen && (
        <AdvancedSearchModal
          initialName={author.text.trim()}
          onPick={(s) => {
            pick(s);
            setAdvOpen(false);
          }}
          onClose={() => setAdvOpen(false)}
        />
      )}
    </div>
  );
}

/* ---------------- Advanced disambiguation search ---------------- */

function AdvancedSearchModal({ initialName, onPick, onClose }) {
  const [name, setName] = useState(initialName);
  const [institution, setInstitution] = useState('');
  const [results, setResults] = useState(null); // null = not searched yet
  const [note, setNote] = useState(null);
  const [searching, setSearching] = useState(false);

  async function handleSearch(e) {
    e.preventDefault();
    if (name.trim().length < 2 || searching) return;
    setSearching(true);
    setNote(null);
    try {
      const params = new URLSearchParams({ q: name.trim() });
      if (institution.trim()) params.set('institution', institution.trim());
      const res = await fetch(`/api/authors/search?${params}`, {
        headers: credentialHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setResults([]);
        setNote(data.error ?? `Search failed (HTTP ${res.status})`);
      } else {
        setResults(data.results ?? []);
        if (data.note) setNote(data.note);
        else if (data.institutionMatches?.length) {
          setNote(`Scoped to: ${data.institutionMatches.map((m) => m.name).join(' · ')}`);
        }
      }
    } catch (err) {
      setResults([]);
      setNote(`Network error: ${err.message}`);
    } finally {
      setSearching(false);
    }
  }

  // Portal to <body>: AuthorInput lives inside the main search <form>, and a
  // nested <form> is invalid HTML — the browser would strip it and the search
  // button would submit the OUTER form instead of running this modal's search.
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box adv-box" onClick={(e) => e.stopPropagation()}>
        <section className="adv-panel">
          <div className="settings-head">
            <h3>🔍 Advanced Disambiguation</h3>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <form className="adv-form" onSubmit={handleSearch}>
            <div className="field">
              <label htmlFor="advName">Scholar name</label>
              <input
                id="advName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Zhanglong Cao"
                autoComplete="off"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="advInst">Institution keyword (optional)</label>
              <input
                id="advInst"
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                placeholder="e.g. Curtin"
                autoComplete="off"
              />
            </div>
            <button className="save-btn adv-search-btn" type="submit" disabled={searching}>
              {searching ? 'Searching…' : '🔎 Search full index'}
            </button>
          </form>

          {note && <div className="adv-note">{note}</div>}

          {results && (
            <div className="adv-results">
              {results.length === 0 && !note && (
                <div className="adv-note">No scholars matched — try loosening the keywords.</div>
              )}
              {results.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className="adv-card"
                  onClick={() =>
                    onPick({
                      id: r.id,
                      name: r.name,
                      hint: r.institution,
                      worksCount: r.worksCount,
                    })
                  }
                >
                  <div className="adv-card-head">
                    <span className="adv-name">{r.name}</span>
                    <span className="adv-id">{r.id}</span>
                  </div>
                  <div className="adv-inst">
                    {r.institution ?? 'Institution unknown'}
                    {r.country ? ` · ${r.country}` : ''}
                  </div>
                  <div className="adv-stats">
                    <span>📄 {r.worksCount.toLocaleString()} works</span>
                    <span>🔗 {r.citedByCount.toLocaleString()} citations</span>
                    {r.concepts.map((c) => (
                      <span key={c} className="adv-badge">{c}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>,
    document.body
  );
}

/* ---------------- Progress timeline ---------------- */

function Timeline({ events, loading, collapsed }) {
  return (
    <section className={`timeline-card ${collapsed ? 'collapsed' : ''}`}>
      <div className="timeline-title">
        {loading ? '🛰️ Live search progress' : '📡 Search log'}
      </div>
      <div className="timeline">
        {events.map((evt, i) => {
          const isLast = i === events.length - 1;
          return (
            <div key={i} className={`tl-item ${isLast && loading ? 'active' : 'done'}`}>
              <div className="tl-rail">
                <div className="tl-dot">{iconFor(evt.state)}</div>
                {i < events.length - 1 && <div className="tl-line" />}
              </div>
              <div className="tl-body">
                <div className="tl-state">{evt.state.replace(/_/g, ' ')}</div>
                <div className="tl-msg">{evt.message}</div>
              </div>
            </div>
          );
        })}
        {loading && events.length === 0 && (
          <div className="tl-item active">
            <div className="tl-rail">
              <div className="tl-dot">🔍</div>
            </div>
            <div className="tl-body">
              <div className="tl-msg">Contacting the academic network…</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------- Result: interactive constellation graph ---------------- */

const NODE_COLORS = { source: '#3b82f6', target: '#ef4444', bridge: '#fbbf24' };
const nodeRadius = (d) => (d.role === 'bridge' ? 16 : 24);

// Edge weight → visuals: thicker and brighter with every extra shared paper.
const linkWidth = (d) => Math.min(1.5 + (d.weight - 1) * 1.2, 6);
const linkOpacity = (d) => Math.min(0.3 + (d.weight - 1) * 0.15, 0.9);

// Backend chain: [{id, name, paper, papers, weight}] where the link fields
// tie each author to the PREVIOUS element. Reshape into D3's {nodes, links}:
// nodes are de-duplicated scholars; duplicate edges between the same pair are
// AGGREGATED into a single link with a `weight` (collaboration count) and a
// merged `papers` array — strong partnerships render as thick bright bonds.
function chainToGraph(result) {
  const chain = result.chain;
  const institutions = {
    [result.authorA.id]: result.authorA.institution,
    [result.authorB.id]: result.authorB.institution,
  };

  const nodes = [];
  const seen = new Set();
  chain.forEach((item, i) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    nodes.push({
      id: item.id,
      name: item.name,
      role: i === 0 ? 'source' : i === chain.length - 1 ? 'target' : 'bridge',
      institution: institutions[item.id] ?? null,
    });
  });

  const linkMap = new Map(); // unordered pair key -> aggregated link
  for (let i = 1; i < chain.length; i++) {
    const s = chain[i - 1].id;
    const t = chain[i].id;
    const key = s < t ? `${s}|${t}` : `${t}|${s}`;
    const papers = chain[i].papers ?? (chain[i].paper ? [chain[i].paper] : []);
    const weight = chain[i].weight ?? Math.max(papers.length, 1);

    const existing = linkMap.get(key);
    if (existing) {
      existing.weight += weight;
      existing.papers.push(...papers);
    } else {
      linkMap.set(key, { source: s, target: t, weight, papers: [...papers] });
    }
  }
  // de-duplicate merged papers (by DOI, falling back to title)
  for (const link of linkMap.values()) {
    const seenPapers = new Set();
    link.papers = link.papers.filter((p) => {
      const k = p.doi ?? p.title;
      if (seenPapers.has(k)) return false;
      seenPapers.add(k);
      return true;
    });
  }

  return { nodes, links: [...linkMap.values()] };
}

function NetworkGraph({ result }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const hideTimer = useRef(null);
  const [tip, setTip] = useState(null); // { kind: 'node'|'link', data, x, y }

  useEffect(() => {
    const wrap = wrapRef.current;
    const width = Math.max(wrap.clientWidth, 320);
    const height = 500;
    const { nodes, links } = chainToGraph(result);

    const svg = d3.select(svgRef.current).attr('viewBox', [0, 0, width, height]);
    svg.selectAll('*').remove();

    // --- starfield backdrop ---
    const starLayer = svg.append('g');
    for (let i = 0; i < 90; i++) {
      starLayer
        .append('circle')
        .attr('class', 'star')
        .attr('cx', Math.random() * width)
        .attr('cy', Math.random() * height)
        .attr('r', Math.random() * 1.3 + 0.3)
        .attr('fill', '#cbd5e1')
        .style('animation-delay', `${(Math.random() * 4).toFixed(2)}s`);
    }

    // --- glow filters ---
    const defs = svg.append('defs');
    const nodeGlow = defs
      .append('filter')
      .attr('id', 'node-glow')
      .attr('x', '-80%').attr('y', '-80%')
      .attr('width', '260%').attr('height', '260%');
    nodeGlow.append('feGaussianBlur').attr('stdDeviation', 6).attr('result', 'blur');
    const nm = nodeGlow.append('feMerge');
    nm.append('feMergeNode').attr('in', 'blur');
    nm.append('feMergeNode').attr('in', 'SourceGraphic');

    const linkGlow = defs
      .append('filter')
      .attr('id', 'link-glow')
      .attr('x', '-40%').attr('y', '-40%')
      .attr('width', '180%').attr('height', '180%');
    linkGlow.append('feGaussianBlur').attr('stdDeviation', 1.8).attr('result', 'blur');
    const lm = linkGlow.append('feMerge');
    lm.append('feMergeNode').attr('in', 'blur');
    lm.append('feMergeNode').attr('in', 'SourceGraphic');

    // Seed positions left-to-right so the entrance unfolds along the chain
    nodes.forEach((n, i) => {
      n.x = (width / (nodes.length + 1)) * (i + 1) + (Math.random() - 0.5) * 24;
      n.y = height / 2 + (Math.random() - 0.5) * 70;
    });

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3.forceLink(links).id((d) => d.id)
          .distance(Math.min(170, width / Math.max(nodes.length, 2)))
          .strength(0.85)
      )
      .force('charge', d3.forceManyBody().strength(-480))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius((d) => nodeRadius(d) + 28));

    // --- links: visible glowing line + fat invisible hit area ---
    // Width/brightness scale with `weight` so best-friend collaborations pop.
    const linkLine = svg
      .append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#64748b')
      .attr('stroke-opacity', linkOpacity)
      .attr('stroke-width', linkWidth)
      .attr('filter', 'url(#link-glow)');

    const linkHit = svg
      .append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'transparent')
      .attr('stroke-width', 20)
      .style('cursor', 'pointer')
      .on('mouseover', (event, d) => {
        cancelHide();
        linkLine
          .filter((l) => l === d)
          .attr('stroke', '#22d3ee')
          .attr('stroke-opacity', 1)
          .attr('stroke-width', linkWidth(d) + 1);
        placeTip(event, { kind: 'link', data: d });
      })
      .on('mouseout', (event, d) => {
        linkLine
          .filter((l) => l === d)
          .attr('stroke', '#64748b')
          .attr('stroke-opacity', linkOpacity(d))
          .attr('stroke-width', linkWidth(d));
        // grace period so the cursor can travel onto the tooltip's DOI links
        scheduleHide();
      })
      .on('click', (event, d) => {
        if (d.papers?.[0]?.doi) window.open(d.papers[0].doi, '_blank', 'noopener');
      });

    // --- nodes: glowing circles + name labels ---
    const nodeGroup = svg
      .append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'grab');

    nodeGroup
      .append('circle')
      .attr('fill', (d) => NODE_COLORS[d.role])
      .attr('fill-opacity', 0.95)
      .attr('stroke', '#ffffff')
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', 1.5)
      .attr('filter', 'url(#node-glow)')
      .attr('r', 0) // entrance: spring from zero
      .transition()
      .duration(750)
      .delay((d, i) => 150 + i * 140)
      .ease(d3.easeElasticOut.amplitude(1).period(0.55))
      .attr('r', nodeRadius);

    nodeGroup
      .append('text')
      .text((d) => d.name)
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => nodeRadius(d) + 18)
      .attr('fill', (d) => (d.role === 'bridge' ? '#fcd34d' : '#f1f5f9'))
      .attr('font-size', (d) => (d.role === 'bridge' ? 12 : 13.5))
      .attr('font-weight', (d) => (d.role === 'bridge' ? 500 : 700))
      .attr('opacity', 0)
      .transition()
      .duration(600)
      .delay((d, i) => 450 + i * 140)
      .attr('opacity', 0.95);

    nodeGroup
      .on('mouseover', function (event, d) {
        cancelHide();
        d3.select(this).select('circle').transition().duration(160).attr('r', nodeRadius(d) * 1.25);
        placeTip(event, { kind: 'node', data: d });
      })
      .on('mouseout', function (event, d) {
        d3.select(this).select('circle').transition().duration(160).attr('r', nodeRadius(d));
        scheduleHide();
      });

    // --- drag: pin the node to the cursor, reheat so the web jiggles ---
    nodeGroup.call(
      d3
        .drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.35).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    );

    function placeTip(event, t) {
      const [x, y] = d3.pointer(event, wrap);
      setTip({
        ...t,
        x: Math.min(x + 16, wrap.clientWidth - 300),
        y: Math.min(y + 14, height - 200),
      });
    }

    function cancelHide() {
      clearTimeout(hideTimer.current);
    }
    function scheduleHide() {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setTip(null), 250);
    }

    simulation.on('tick', () => {
      // keep the constellation inside the canvas
      nodes.forEach((n) => {
        n.x = Math.max(46, Math.min(width - 46, n.x));
        n.y = Math.max(46, Math.min(height - 64, n.y));
      });
      linkLine
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      linkHit
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      nodeGroup.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    return () => {
      simulation.stop();
      clearTimeout(hideTimer.current);
    };
  }, [result]);

  return (
    <div className="graph-wrap" ref={wrapRef}>
      <svg ref={svgRef} className="graph-svg" />
      {tip && (
        <GraphTooltip
          tip={tip}
          onEnter={() => clearTimeout(hideTimer.current)}
          onLeave={() => setTip(null)}
        />
      )}
    </div>
  );
}

function GraphTooltip({ tip, onEnter, onLeave }) {
  const style = { left: tip.x, top: tip.y };

  if (tip.kind === 'node') {
    const d = tip.data;
    return (
      <div className="graph-tooltip" style={style}>
        <div className="tt-label">
          {d.role === 'source' ? '🔵 Scholar A' : d.role === 'target' ? '🔴 Scholar B' : '🟡 Bridge scholar'}
        </div>
        <div className="tt-title">{d.name}</div>
        <div className="tt-row">{d.institution ?? 'Institution unknown'}</div>
        <div className="tt-row tt-mono">OpenAlex: {d.id}</div>
      </div>
    );
  }

  // Link tooltip: aggregated collaboration — interactive so DOIs are clickable
  const { weight, papers } = tip.data;
  return (
    <div
      className="graph-tooltip interactive"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="tt-label">
        🤝 Co-authored {weight} paper{weight === 1 ? '' : 's'}
        {weight > papers.length ? ` (${papers.length} shown)` : ''}
      </div>
      <div className="tt-papers">
        {papers.map((p, i) => (
          <div key={i} className="tt-paper">
            <div className="tt-title">{p.title ?? '(untitled)'}</div>
            <div className="tt-row">
              {p.year && <span>{p.year}</span>}
              {p.doi && (
                <a href={p.doi} target="_blank" rel="noreferrer">
                  {p.doi.replace('https://doi.org/', 'DOI: ')}
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphResult({ result, onCertificate }) {
  return (
    <section className="graph-card">
      <div className="graph-head">
        <h2>🌌 Connection constellation</h2>
        <div className="degree-badge dark">
          {result.degrees} degree{result.degrees === 1 ? '' : 's'} of separation
        </div>
      </div>

      <NetworkGraph result={result} />

      <div className="graph-legend">
        <span><i className="sw" style={{ background: NODE_COLORS.source }} /> {result.authorA.name}</span>
        <span><i className="sw" style={{ background: NODE_COLORS.bridge }} /> Bridge scholars</span>
        <span><i className="sw" style={{ background: NODE_COLORS.target }} /> {result.authorB.name}</span>
        <span className="legend-hint">Drag the stars · thicker bonds = more papers together</span>
      </div>

      <button className="cert-btn" onClick={onCertificate}>
        🎓 Generate Academic Lineage Certificate
      </button>

      <Meta meta={result.meta} />
    </section>
  );
}

function NotFound({ result }) {
  return (
    <section className="result-card">
      <div className="result-head">
        <h2>😔 No path found</h2>
      </div>
      <p className="not-found">
        <strong>{result.authorA?.name}</strong> and <strong>{result.authorB?.name}</strong>:{' '}
        {result.reason} Try full English names, or scholars with more active collaboration
        networks.
      </p>
      <Meta meta={result.meta} />
    </section>
  );
}

function Meta({ meta }) {
  if (!meta) return null;
  return (
    <div className="meta-line">
      {(meta.elapsedMs / 1000).toFixed(1)}s · {meta.apiCalls} OpenAlex API calls
    </div>
  );
}

/* ---------------- Certificate poster (html2canvas) ---------------- */

function CertificateModal({ result, onClose }) {
  const certRef = useRef(null);
  const [saving, setSaving] = useState(false);

  const a = result.authorA;
  const b = result.authorB;
  const papers = result.chain.filter((n) => n.paper).map((n) => n.paper);
  const chainNames = result.chain.map((n) => n.name).join('  →  ');
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  async function handleDownload() {
    if (!certRef.current || saving) return;
    setSaving(true);
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(certRef.current, {
        scale: 2, // crisp, share-ready resolution
        backgroundColor: null,
        useCORS: true,
      });
      const link = document.createElement('a');
      link.download = `academiachain-certificate-${a.name.replace(/\s+/g, '-')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      alert(`Failed to render the poster: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="certificate" ref={certRef}>
          <div className="cert-inner">
            <div className="cert-brand">🔗 AcademiaChain</div>
            <div className="cert-cap">🎓</div>
            <div className="cert-title">Certificate of Academic Kinship</div>
            <div className="cert-sub">This is to certify that</div>
            <div className="cert-names">
              <span>{a.name}</span> &amp; <span>{b.name}</span>
            </div>
            <div className="cert-sub">
              are connected through the scholarly co-authorship network at
            </div>
            <div className="cert-degree">
              <div className="cert-degree-num">{result.degrees}</div>
              <div className="cert-degree-label">
                degree{result.degrees === 1 ? '' : 's'} of separation
              </div>
            </div>
            <div className="cert-chain">{chainNames}</div>
            {papers.length > 0 && (
              <div className="cert-papers">
                <div className="cert-papers-title">— Key bridging works —</div>
                {papers.slice(0, 3).map((p, i) => (
                  <div key={i} className="cert-paper">
                    “{p.title}”{p.year ? ` (${p.year})` : ''}
                  </div>
                ))}
              </div>
            )}
            <div className="cert-footer">
              <span>Issued {today}</span>
              <span>Verified via the OpenAlex open scholarly graph</span>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="cert-btn" onClick={handleDownload} disabled={saving}>
            {saving ? 'Rendering…' : '💾 Save as PNG'}
          </button>
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
