# AI Crawler Check

Chrome extension. Checks any site's robots.txt and llms.txt and shows which AI crawlers are allowed or blocked. Built by [GOJI](https://goji.agency/tools/ai-crawler-check).

Click the toolbar icon on any page. The extension reads `robots.txt` and `llms.txt` from that page's origin, parses the rules the way a crawler would, and shows Allowed, Blocked, Partly blocked or Unknown for each of 16 AI crawler user agents: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, Googlebot, Google-Extended, Applebot, Applebot-Extended, meta-externalagent, CCBot, Bytespider and Amazonbot.

Everything runs in your browser. No account, no tracking, no analytics, nothing sent anywhere. The only network requests the extension makes are to the active tab's own origin, for those two files, when you click the icon.

## What ships

**The Chrome Web Store package is the [`extension/`](extension/) directory only.** Zip the contents of `extension/` and nothing else. Everything outside it (`test/`, `assets/`, `package.json`, this README, `LICENSE`, `.gitignore`) is development tooling or source assets and must not be included in the store zip.

```
extension/          <- the packable extension, self-contained
  manifest.json
  popup.html
  popup.css
  popup.js
  parser.js
  icons/            <- GOJI icon at 128, 48 and 16
assets/             <- icon source (SVG) and variants, never shipped
test/               <- dev only, never shipped
  parser.test.js
  fixtures/*.json
package.json        <- dev only, test script, zero dependencies
```

## Load it unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` directory.
4. Pin the extension and click its icon on any http or https page.

Pages that are not http or https (`chrome://` pages, the new tab page, `file://` URLs, other extensions' pages) show "Cannot check this page".

## Run the tests

Requires Node 20 or later. No dependencies to install.

```
npm test
```

This runs the parser against every fixture in `test/fixtures/` with Node's built-in test runner. Fixtures are JSON files carrying a simulated HTTP response (status, content type, body, or a network error) and the expected status for each crawler, so HTTP-level behaviour (404s, 403s, soft-404 HTML pages, server errors) is tested the same way as parsing behaviour.

## How statuses are decided

The parser follows robots.txt semantics the way major crawlers implement them:

- Rules are grouped by `User-agent`. Consecutive `User-agent` lines share one rule block. User agent tokens match case-insensitively and exactly; two groups naming the same agent are merged.
- A named group **replaces** the `*` group. If GPTBot has its own group, the `*` rules do not apply to GPTBot at all.
- Access is evaluated against the site root `/`. Between `Allow` and `Disallow`, the longest matching pattern wins; on equal length, `Allow` wins. `*` and trailing `$` wildcards are supported.
- **Allowed**: the root is allowed and no rule in the bot's group still blocks a subpath.
- **Blocked**: the root is disallowed.
- **Partly blocked**: the root is allowed but at least one `Disallow` in the bot's group still blocks a subpath (a `Disallow` fully overridden by an `Allow` does not count).
- **Unknown**: the file could not be read reliably, detailed below.
- `Crawl-delay`, `Sitemap`, `Host` and unknown directives are ignored without failing the parse. Malformed lines are skipped.

HTTP handling:

| Response | robots.txt result | llms.txt result |
|---|---|---|
| 200 with text content | Parsed | Present, contents shown |
| 200 with an HTML page | Treated as no file (soft 404): all allowed | Not found |
| 404 and other 4xx | No file: all allowed | Not found |
| 401 / 403 / 429 | Unknown, with a note. Bot protection commonly returns these; treating them as Allowed would be a false pass | Unknown, with a note |
| 5xx or network failure | Unknown, with a note | Unknown, with a note |

Redirects: same-origin redirects are followed silently. A cross-origin redirect fails (the extension only has permission for the active tab's origin) and reports Unknown with a note.

## Permissions

`activeTab` only. It grants temporary access to the active tab's origin when you click the icon, which is what allows the two fetches. No host permissions, no other permissions.

## License

[MIT](LICENSE)
