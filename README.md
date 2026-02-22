# Assets Cacher

A Chrome extension (Manifest V3) that reduces bandwidth consumption by overriding HTTP cache headers on static assets. It uses `declarativeNetRequest` to intercept response headers on provably-static files and replace the server's conservative (or absent) `Cache-Control` value with a long-lived one, causing Chrome's native disk cache to retain the file across sessions.

---

## How it works

Most web servers return conservative cache headers (`Cache-Control: no-cache`, `max-age=0`, or `private`) on static assets, causing the browser to revalidate or re-download them on every page load. This extension uses Chrome's `declarativeNetRequest` API with a `modifyHeaders` action to safely replace `Cache-Control` on qualifying assets with:

```
Cache-Control: max-age=31536000
```

*Note: The `public` directive is intentionally omitted to respect standard private caching boundaries on authenticated CDNs, while still forcing local disk retention.*

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
  background.js sees miss + fingerprint -> stores exact Content-Length in an in-memory Map (synced to local storage)
  Chrome disk cache stores asset

Subsequent visits:
  Browser -> Chrome disk cache (0 bytes transferred)
  background.js sees fromCache: true -> looks up stored size -> logs as savings
```

### Targeting rules

To prevent CPU taxation and strictly avoid breaking dynamic authenticated endpoints, the extension does not apply the override to all requests. `rules.json` uses a highly optimized `regexFilter` mapped to DNR `resourceTypes`. It exclusively targets URLs ending exactly in known static extensions `(?i)` case-insensitively (`.js`, `.css`, `.woff2`, `.ttf`, `.png`, `.jpg`, `.svg`, `.mp4`, etc.). Extensionless URLs are ignored by design.

### Why not IndexedDB or Service Worker interception?

Earlier iterations of this extension attempted to cache assets in IndexedDB and serve them via a Service Worker fetch handler, using DNR redirects to route requests through an internal proxy endpoint.

This approach failed for two reasons:
1. **Relative path corruption** — Redirecting a CDN-hosted CSS file to `chrome-extension://id/proxy.html` breaks all relative `url()` references inside the stylesheet. The browser resolves them against the extension origin instead of the original CDN.
2. **Double-fetch overhead** — The `webRequest.onCompleted` API fires after the browser has already consumed the response body. To populate IndexedDB, the extension had to issue a second `fetch()` for every new asset, doubling bandwidth on first visits.

The header-override approach avoids both problems entirely. The browser handles storage, serving, and eviction natively.

---

## Features

- **Targeted header injection** — `rules.json` scopes caching strictly by exact static asset extensions (`.js`, `.png`, etc.) avoiding expensive multi-boundary regex filters and ensuring zero interference with dynamic endpoints.
- **Honest bandwidth accounting** — Each forced asset is fingerprinted with `X-Assets-Cacher-Forced`. Because Chrome preserves injected headers in the disk cache, `background.js` natively detects this header on cache hits. Known asset metrics are stored in `chrome.storage.local`, perfectly surviving browser restarts. (If the server obscures the file size via chunked-transfer encoding, a logical estimation is applied based on the file extension).
- **Lock-free architecture** — Network hits modify memory `Map` instances synchronously (ensuring a 0ms O(1) delay on the Service Worker thread) with strict LRU (Least Recently Used) automatic garbage collection. To prevent early-wake race conditions, network handlers queue dynamically behind an asynchronous storage hydration Promise array. A central debouncing daemon flushes the memory state to `chrome.storage` asynchronously every 2 seconds, utilizing `isDirty` flags to guarantee zero I/O disk thrashing during idle phases.
- **Per-site disable** — Toggle caching off for a hostname from the popup. Implemented dynamically through an auto-incrementing Rule ID allocator (starting at ID 10000) stored in `chrome.storage.local`, guaranteeing zero DNR rule collisions.
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