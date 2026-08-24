// robots.txt and llms.txt analysis for AI Crawler Check.
// Pure functions over response-shaped input so the same code runs in the
// popup and in the Node test suite. No DOM, no chrome.* APIs.

export const CRAWLER_GROUPS = [
  { group: 'OpenAI', bots: ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User'] },
  { group: 'Anthropic', bots: ['ClaudeBot', 'Claude-User', 'Claude-SearchBot'] },
  { group: 'Perplexity', bots: ['PerplexityBot', 'Perplexity-User'] },
  { group: 'Google', bots: ['Googlebot', 'Google-Extended'] },
  { group: 'Apple', bots: ['Applebot', 'Applebot-Extended'] },
  { group: 'Meta', bots: ['meta-externalagent'] },
  { group: 'Other', bots: ['CCBot', 'Bytespider', 'Amazonbot'] },
];

export const ALL_BOTS = CRAWLER_GROUPS.flatMap((g) => g.bots);

export const STATUS = {
  ALLOWED: 'allowed',
  BLOCKED: 'blocked',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
};

// Fetch outcomes shared by both files.
export const OUTCOME = {
  PARSED: 'parsed', // 2xx with usable text content
  MISSING: 'missing', // 404, other 4xx, or a soft-404 HTML page
  UNREACHABLE: 'unreachable', // 5xx, 401/403/429, network failure
};

// --- robots.txt parsing ---------------------------------------------------

// Parse robots.txt text into rule groups:
//   [{ agents: ['gptbot', '*'], rules: [{ type: 'allow'|'disallow', path }] }]
// Consecutive User-agent lines share one block. Lines other than
// user-agent/allow/disallow (Crawl-delay, Sitemap, Host, unknown, garbage)
// are ignored and do not split a block. Rules before any User-agent line
// are ignored. Never throws on malformed input.
export function parseRobotsTxt(text) {
  const groups = [];
  let current = null;
  let currentHasRules = false;

  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/);

  for (const rawLine of lines) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (directive === 'user-agent') {
      if (!value) continue;
      if (current === null || currentHasRules) {
        current = { agents: [], rules: [] };
        currentHasRules = false;
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (directive === 'allow' || directive === 'disallow') {
      if (current === null) continue;
      currentHasRules = true;
      // An empty Allow/Disallow value matches nothing; record no rule.
      if (value) current.rules.push({ type: directive, path: value });
    }
    // Everything else (crawl-delay, sitemap, host, unknown) is ignored.
  }

  return groups;
}

// A path pattern matches from the start of the URL path. '*' matches any
// character sequence; a trailing '$' anchors the end. '$' anywhere else is
// literal.
export function patternMatches(pattern, path) {
  let body = pattern;
  let anchored = false;
  if (body.endsWith('$')) {
    anchored = true;
    body = body.slice(0, -1);
  }
  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + source + (anchored ? '$' : '')).test(path);
}

// Longest pattern wins between Allow and Disallow; on equal length Allow
// wins. No matching rule means allowed.
export function decide(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (!patternMatches(rule.path, path)) continue;
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.type === 'allow' && best.type === 'disallow')
    ) {
      best = rule;
    }
  }
  return best === null || best.type === 'allow';
}

// Effective rules for one bot: the union of every group naming the bot
// exactly (case-insensitive). A named match replaces the '*' groups; the
// '*' groups apply only when no group names the bot. Returns null when no
// group applies at all.
function effectiveRules(groups, botName) {
  const token = botName.toLowerCase();
  let named = [];
  let star = [];
  for (const group of groups) {
    if (group.agents.includes(token)) named.push(group);
    else if (group.agents.includes('*')) star.push(group);
  }
  const applicable = named.length > 0 ? named : star;
  if (applicable.length === 0) return null;
  return applicable.flatMap((g) => g.rules);
}

// A Disallow contributes to "Partly blocked" when, with the whole rule set
// applied, it still blocks a representative subpath. The representative
// path is the pattern with each '*' replaced by 'x'; an end-anchored
// pattern that only ever matched the root is skipped, and an unanchored
// root pattern is probed one segment deeper.
function blocksSomeSubpath(rules, disallow) {
  let sample = disallow.path;
  let anchored = false;
  if (sample.endsWith('$')) {
    anchored = true;
    sample = sample.slice(0, -1);
  }
  sample = sample.replaceAll('*', 'x');
  if (!sample.startsWith('/')) sample = '/' + sample;
  if (sample === '/') {
    if (anchored) return false;
    sample = '/x';
  }
  return !decide(rules, sample);
}

export function statusForBot(groups, botName) {
  const rules = effectiveRules(groups, botName);
  if (rules === null || rules.length === 0) return STATUS.ALLOWED;
  if (!decide(rules, '/')) return STATUS.BLOCKED;
  const partial = rules.some((r) => r.type === 'disallow' && blocksSomeSubpath(rules, r));
  return partial ? STATUS.PARTIAL : STATUS.ALLOWED;
}

// --- HTTP response interpretation ------------------------------------------

// Many sites serve an HTML page (a soft 404) at /robots.txt or /llms.txt.
// Detect via the Content-Type header, or by sniffing an HTML document start
// when the header is absent or lying.
export function looksLikeHtml(contentType, body) {
  if ((contentType || '').toLowerCase().includes('text/html')) return true;
  const head = String(body ?? '').replace(/^\uFEFF/, '').trimStart().slice(0, 15).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

// Classify a fetch result for either file.
//   response: { networkError: true } | { status, contentType, body }
// Returns { outcome, reason } where reason explains UNREACHABLE.
export function classifyResponse(response) {
  if (!response || response.networkError) {
    return { outcome: OUTCOME.UNREACHABLE, reason: 'network' };
  }
  const { status } = response;
  if (status === 401 || status === 403) {
    return { outcome: OUTCOME.UNREACHABLE, reason: 'http-' + status };
  }
  if (status === 429) return { outcome: OUTCOME.UNREACHABLE, reason: 'http-429' };
  if (status >= 500) return { outcome: OUTCOME.UNREACHABLE, reason: 'http-5xx' };
  if (status >= 400) return { outcome: OUTCOME.MISSING, reason: null };
  if (status >= 200 && status < 300) {
    if (looksLikeHtml(response.contentType, response.body)) {
      return { outcome: OUTCOME.MISSING, reason: null };
    }
    return { outcome: OUTCOME.PARSED, reason: null };
  }
  // Anything else (a 3xx that survived redirect-following, 1xx) is
  // uninterpretable; do not guess.
  return { outcome: OUTCOME.UNREACHABLE, reason: 'http-other' };
}

// Full robots.txt analysis.
// Returns { outcome, reason, bots: { <name>: status } }.
export function analyzeRobots(response, botNames = ALL_BOTS) {
  const { outcome, reason } = classifyResponse(response);
  const bots = {};
  if (outcome === OUTCOME.PARSED) {
    const groups = parseRobotsTxt(response.body);
    for (const name of botNames) bots[name] = statusForBot(groups, name);
  } else {
    const fallback = outcome === OUTCOME.MISSING ? STATUS.ALLOWED : STATUS.UNKNOWN;
    for (const name of botNames) bots[name] = fallback;
  }
  return { outcome, reason, bots };
}

// Full llms.txt analysis.
// Returns { state: 'present'|'not_found'|'unknown', reason, body }.
export function analyzeLlms(response) {
  const { outcome, reason } = classifyResponse(response);
  if (outcome === OUTCOME.PARSED) return { state: 'present', reason: null, body: response.body };
  if (outcome === OUTCOME.MISSING) return { state: 'not_found', reason: null, body: null };
  return { state: 'unknown', reason, body: null };
}
