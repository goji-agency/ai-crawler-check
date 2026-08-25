import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_BOTS,
  CRAWLER_GROUPS,
  analyzeRobots,
  analyzeLlms,
  parseRobotsTxt,
  patternMatches,
  decide,
  statusForBot,
  looksLikeHtml,
} from '../extension/parser.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')));

describe('crawler list', () => {
  test('covers all 16 crawlers from the spec in order', () => {
    assert.deepEqual(ALL_BOTS, [
      'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
      'ClaudeBot', 'Claude-User', 'Claude-SearchBot',
      'PerplexityBot', 'Perplexity-User',
      'Googlebot', 'Google-Extended',
      'Applebot', 'Applebot-Extended',
      'meta-externalagent',
      'CCBot', 'Bytespider', 'Amazonbot',
    ]);
    assert.deepEqual(
      CRAWLER_GROUPS.map((g) => g.group),
      ['OpenAI', 'Anthropic', 'Perplexity', 'Google', 'Apple', 'Meta', 'Other'],
    );
  });
});

describe('robots.txt fixtures', () => {
  for (const fixture of fixtures.filter((f) => f.file === 'robots')) {
    test(`${fixture.name}: ${fixture.description}`, () => {
      for (const key of Object.keys(fixture.expected.overrides)) {
        assert.ok(ALL_BOTS.includes(key), `fixture override names unknown bot ${key}`);
      }
      const result = analyzeRobots(fixture.response);
      assert.equal(result.outcome, fixture.expected.outcome, 'outcome');
      for (const bot of ALL_BOTS) {
        const expected = fixture.expected.overrides[bot] ?? fixture.expected.defaultStatus;
        assert.equal(result.bots[bot], expected, `status for ${bot}`);
      }
    });
  }

  test('unreachable results carry a reason for the visible note', () => {
    assert.equal(analyzeRobots({ status: 403, contentType: '', body: '' }).reason, 'http-403');
    assert.equal(analyzeRobots({ status: 401, contentType: '', body: '' }).reason, 'http-401');
    assert.equal(analyzeRobots({ status: 429, contentType: '', body: '' }).reason, 'http-429');
    assert.equal(analyzeRobots({ status: 503, contentType: '', body: '' }).reason, 'http-5xx');
    assert.equal(analyzeRobots({ networkError: true }).reason, 'network');
  });

  test('llms unknown states carry the same reason for the visible note', () => {
    assert.equal(analyzeLlms({ status: 403, contentType: '', body: '' }).reason, 'http-403');
    assert.equal(analyzeLlms({ status: 503, contentType: '', body: '' }).reason, 'http-5xx');
    assert.equal(analyzeLlms({ networkError: true }).reason, 'network');
  });
});

describe('llms.txt fixtures', () => {
  for (const fixture of fixtures.filter((f) => f.file === 'llms')) {
    test(`${fixture.name}: ${fixture.description}`, () => {
      const result = analyzeLlms(fixture.response);
      assert.equal(result.state, fixture.expected.state);
      if (result.state === 'present') {
        assert.equal(result.body, fixture.response.body);
      } else {
        assert.equal(result.body, null);
      }
    });
  }
});

describe('pattern matching', () => {
  test('prefix match from the start of the path', () => {
    assert.equal(patternMatches('/admin', '/admin'), true);
    assert.equal(patternMatches('/admin', '/admin/users'), true);
    assert.equal(patternMatches('/admin', '/adminium'), true);
    assert.equal(patternMatches('/admin', '/blog/admin'), false);
    assert.equal(patternMatches('/', '/anything/at/all'), true);
  });

  test('* matches any character sequence including none', () => {
    assert.equal(patternMatches('/*', '/'), true);
    assert.equal(patternMatches('/*/private', '/a/private'), true);
    assert.equal(patternMatches('/*.pdf', '/files/report.pdf'), true);
    assert.equal(patternMatches('/*.pdf', '/files/report.txt'), false);
  });

  test('trailing $ anchors the end, $ elsewhere is literal', () => {
    assert.equal(patternMatches('/$', '/'), true);
    assert.equal(patternMatches('/$', '/page'), false);
    assert.equal(patternMatches('/*.php$', '/index.php'), true);
    assert.equal(patternMatches('/*.php$', '/index.php5'), false);
    assert.equal(patternMatches('/a$b', '/a$b/c'), true);
  });

  test('regex metacharacters in patterns are literal', () => {
    assert.equal(patternMatches('/a.b', '/a.b'), true);
    assert.equal(patternMatches('/a.b', '/axb'), false);
    assert.equal(patternMatches('/a+b(c)', '/a+b(c)/d'), true);
  });

  test('wildcard-heavy patterns cannot blow up matching time', () => {
    const pattern = '/' + 'a*'.repeat(40) + 'b$';
    const path = '/' + 'a'.repeat(5000) + 'c';
    const started = performance.now();
    assert.equal(patternMatches(pattern, path), false);
    assert.ok(performance.now() - started < 200, 'matching must stay linear');
  });
});

describe('rule precedence', () => {
  test('longest match wins regardless of rule order', () => {
    const rules = [
      { type: 'disallow', path: '/shop' },
      { type: 'allow', path: '/shop/public' },
    ];
    assert.equal(decide(rules, '/shop/private'), false);
    assert.equal(decide(rules, '/shop/public/item'), true);
  });

  test('equal length goes to allow in either rule order', () => {
    assert.equal(decide([{ type: 'disallow', path: '/' }, { type: 'allow', path: '/' }], '/'), true);
    assert.equal(decide([{ type: 'allow', path: '/x' }, { type: 'disallow', path: '/x' }], '/x'), true);
    assert.equal(decide([{ type: 'disallow', path: '/x' }, { type: 'allow', path: '/x' }], '/x'), true);
  });

  test('no matching rule means allowed', () => {
    assert.equal(decide([{ type: 'disallow', path: '/private' }], '/'), true);
    assert.equal(decide([], '/'), true);
  });
});

describe('group resolution', () => {
  const groups = parseRobotsTxt(
    'User-agent: *\nDisallow: /*\n\nUser-agent: GPTBot\nDisallow: /gpt\n',
  );

  test('a named group replaces the * group', () => {
    // Merging instead of replacing would give GPTBot the * group's
    // root-blocking Disallow: /* and turn partial into blocked.
    assert.equal(statusForBot(groups, 'GPTBot'), 'partial');
    assert.equal(statusForBot(groups, 'ClaudeBot'), 'blocked');
  });

  test('a bot with no applicable group at all is allowed', () => {
    const named = parseRobotsTxt('User-agent: OtherBot\nDisallow: /\n');
    assert.equal(statusForBot(named, 'GPTBot'), 'allowed');
  });

  test('parse never throws on junk input', () => {
    for (const junk of [null, undefined, '', '\u0000\u0001', ':::::', '#only\n#comments', 'a'.repeat(100000)]) {
      assert.doesNotThrow(() => parseRobotsTxt(junk));
    }
  });
});

describe('html detection', () => {
  test('content-type header wins', () => {
    assert.equal(looksLikeHtml('text/html; charset=utf-8', 'User-agent: *'), true);
    assert.equal(looksLikeHtml('text/plain', 'User-agent: *'), false);
  });

  test('body sniff catches soft 404s with lying or missing headers', () => {
    assert.equal(looksLikeHtml('', '  <!DOCTYPE html><html>'), true);
    assert.equal(looksLikeHtml('text/plain', '<html><body>404'), true);
    assert.equal(looksLikeHtml('text/plain', '<?xml version="1.0"?><html xmlns='), true);
    assert.equal(looksLikeHtml('text/plain', '<!-- error page -->\n<html>'), true);
    assert.equal(looksLikeHtml('', 'User-agent: *\nDisallow: /'), false);
    assert.equal(looksLikeHtml('', '<<<%%% merge conflict junk\nUser-agent: *'), false);
  });
});

describe('oversized input', () => {
  test('parsing is capped at 500 KiB without losing early groups', () => {
    const text = 'User-agent: GPTBot\nDisallow: /\n' + '# filler\n'.repeat(80000);
    const groups = parseRobotsTxt(text);
    assert.equal(statusForBot(groups, 'GPTBot'), 'blocked');
  });
});
