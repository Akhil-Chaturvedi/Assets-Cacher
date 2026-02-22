# Assets Cacher

A Chrome extension (Manifest V3) that reduces bandwidth consumption by overriding HTTP cache headers on static assets. It uses `declarativeNetRequest` to intercept response headers on provably-static files and replace the server's conservative (or absent) `Cache-Control` value with a long-lived one, causing Chrome's native disk cache to retain the file across sessions.

---

## How it works

Most web servers return conservative cache headers (`Cache-Control: no-cache`, `max-age=0`, or `private`) on static assets, causing the browser to revalidate or re-download them on every page load. This extension uses Chrome's `declarativeNetRequest` API with a `modifyHeaders` action to replace `Cache-Control` on qualifying assets with:

```
Cache-Control: public, max-age=31536000
```

A second header is injected simultaneously:

```
X-Assets-Cacher-Forced: true
```

This acts as a fingerprint. On the initial download (cache miss), `background.js` detects this header and stores the asset's exact `Content-Length` in `chrome.storage.session`. On subsequent visits, when Chrome serves the asset from disk (`fromCache: true`), the extension looks up the stored size and credits exactly those bytes as bandwidth saved. This prevents the extension from taking credit for files that Chrome was already caching natively.

### Request flow

```
First visit:
  Browser -> Network -> Server responds with asset
  URL matches static regex (e.g. ends in .js, .css, .png):
    DNR injects: Cache-Control: public, max-age=31536000
    DNR injects: X-Assets-Cacher-Forced: true
  background.js sees miss + fingerprint -> stores exact Content-Length in session
  Chrome disk cache stores asset

Subsequent visits:
  Browser -> Chrome disk cache (0 bytes transferred)
  background.js sees fromCache: true -> looks up stored size -> logs as savings
```

### Targeting rules

The extension does not blindly apply the override to all requests. `rules.json` is scoped by DNR `resourceTypes` to only target standard static formats (stylesheets, scripts, images, fonts, media). An `excludedRegexFilter` using strict word boundaries (`\b`) prevents the rule from firing on paths containing patterns like `/captcha/`, `/analytics/`, `/auth/`, `token=`, `.php`, and similar indicators of dynamic or authenticated content.

### Why not IndexedDB or Service Worker interception?

Earlier iterations of this extension attempted to cache assets in IndexedDB and serve them via a Service Worker fetch handler, using DNR redirects to route requests through an internal proxy endpoint.

This approach failed for two reasons:
1. **Relative path corruption** — Redirecting a CDN-hosted CSS file to `chrome-extension://id/proxy.html` breaks all relative `url()` references inside the stylesheet. The browser resolves them against the extension origin instead of the original CDN.
2. **Double-fetch overhead** — The `webRequest.onCompleted` API fires after the browser has already consumed the response body. To populate IndexedDB, the extension had to issue a second `fetch()` for every new asset, doubling bandwidth on first visits.

The header-override approach avoids both problems entirely. The browser handles storage, serving, and eviction natively.

---

## Features

- **Targeted header injection** — `rules.json` scopes caching strictly by asset type and explicitly excludes captcha, analytics, tracking, and authenticated endpoints using strict word boundary exclusions to prevent false positives.
- **Honest bandwidth accounting** — Each forced asset is fingerprinted with `X-Assets-Cacher-Forced`. Because Chrome preserves injected headers in the disk cache, `background.js` natively detects this header on cache hits. Bandwidth savings are counted only for fingerprinted assets.
- **Ephemeral-safe session memory** — MV3 Service Workers are killed by Chrome after ~30 seconds of inactivity. Session counters live in `chrome.storage.session`, which survives SW restarts but resets when the browser closes.
- **Per-site disable** — Toggle caching off for a hostname from the popup. Implemented as a dynamic DNR `allow` rule with a deterministic rule ID derived by hashing the hostname, preventing rule ID collisions.
- **Hard refresh passthrough** — `Ctrl+Shift+R` bypasses the disk cache natively. The extension re-injects headers on the fresh download, re-caching automatically.

---

## File structure

```
Assets-Cacher/
  manifest.json      MV3 manifest with declarativeNetRequest ruleset
  rules.json         Static DNR rule: regexFilter-based Cache-Control injection
  background.js      Service worker: fingerprint tracking, session stats, per-site DNR exceptions
  popup.html/.js     Per-site stats, enable/disable toggle
  popup.css          Styles shared by popup and options page
  options.html/.js   Aggregate bandwidth dashboard
  icons/             Extension icons (16/48/128px)
```

---

## Installation

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project directory.

## Usage

1. Browse normally. The extension silently overrides cache headers on qualifying static assets.
2. Click the extension icon to view per-site hit count and bandwidth saved, and to toggle caching.
3. Use `Ctrl+Shift+R` to force a fresh download if a site's assets appear stale.
4. Open the options page for aggregate session metrics.

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist cumulative bandwidth stats and per-site preferences |
| `declarativeNetRequest` | Apply the static header-override rule via `rules.json` |
| `declarativeNetRequestFeedback` | Required to add and remove dynamic per-site exception rules |
| `webRequest` | Observe `onCompleted` events to detect `fromCache` hits and inspect the `X-Assets-Cacher-Forced` fingerprint |
| `tabs` | Read active tab URL for per-site badge and popup state |
| `<all_urls>` (host) | Apply header overrides across all origins |

---

## Limitations

- **Cache eviction is browser-managed.** Chrome's disk cache has a finite quota (typically a few hundred MB to a few GB depending on available disk space). When full, Chrome evicts least-recently-used entries. The extension has no control over this.
- **Un-hashed filenames.** If a site updates `app.js` without a cache-busting hash, the user gets the old version for up to a year unless they hard-refresh (`Ctrl+Shift+R`). This is a trade-off of aggressive caching. Sites that use file hashing (`app.abc123.js`) are unaffected.
- **Session memory resets on browser close.** `chrome.storage.session` is cleared when the browser closes. The cumulative `totalSavings` counter in `chrome.storage.local` persists, but per-site hit counts reset.
- **Regex coverage is not exhaustive.** The `excludedRegexFilter` excludes known dynamic patterns, but novel dynamic endpoints that happen to end in a static extension (e.g., `/api/data.js`) will be affected. Such patterns can be excluded by disabling the extension for that hostname via the popup toggle.

## License

GPL-3.0. See [LICENSE](LICENSE).