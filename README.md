# Assets Cacher

A Chrome extension (Manifest V3) that reduces bandwidth consumption by overriding HTTP cache headers on static assets. It injects long-lived `Cache-Control` directives into server responses, forcing Chrome's native disk cache to retain stylesheets, scripts, images, fonts, and media files across sessions.

---

## How it works

Most web servers return conservative cache headers (`Cache-Control: no-cache`, `max-age=0`, or `private`) on static assets, causing the browser to revalidate or re-download them on every page load. This extension uses Chrome's `declarativeNetRequest` API to intercept response headers and replace the `Cache-Control` value with:

```
Cache-Control: public, max-age=31536000, immutable
```

This tells the browser to treat the asset as permanently cacheable for one year. Chrome's native HTTP cache engine (which operates at the C++ level, far more efficiently than any JavaScript-based solution) stores the file on disk and serves it locally on subsequent requests — with zero network activity.

### Request flow

```
First visit:
  Browser --> Network --> Server responds with asset
  DNR rule overwrites Cache-Control header to max-age=1yr
  Chrome disk cache stores asset locally

Subsequent visits:
  Browser --> Chrome disk cache (served from disk, 0 bytes transferred)
  Extension monitors fromCache flag to track bandwidth savings
```

### Why not IndexedDB or Service Worker interception?

Earlier iterations of this extension attempted to cache assets in IndexedDB and serve them via a Service Worker fetch handler, using DNR redirects to route requests through an internal proxy endpoint.

This approach failed for two reasons:
1. **Relative path corruption** — Redirecting a CDN-hosted CSS file to `chrome-extension://id/proxy.html` breaks all relative `url()` references inside the stylesheet, since the browser resolves them against the extension origin instead of the original CDN.
2. **Double-fetch overhead** — The `webRequest.onCompleted` API fires after the browser has already consumed the response body. To populate IndexedDB, the extension had to issue a second `fetch()` for every new asset, doubling bandwidth on first visits.

The header-override approach avoids both problems entirely. The browser handles storage, serving, and eviction natively.

---

## Features

- **Header injection** — Static DNR rule overrides `Cache-Control` on all static asset types (stylesheets, scripts, images, fonts, media).
- **Per-site disable** — Toggle caching off for specific hostnames via the popup. Implemented as a dynamic DNR `allow` rule that bypasses the static header override.
- **Bandwidth tracking** — Monitors `webRequest.onCompleted` events and checks `details.fromCache` to count cache hits and estimate bytes saved.
- **Session statistics** — Popup displays per-site hit count, miss count, hit rate, and cumulative bandwidth saved.
- **Options dashboard** — Shows aggregate session metrics (total hits, total bytes saved).
- **Hard refresh support** — `Ctrl+Shift+R` bypasses the disk cache natively (standard browser behavior), re-downloads all assets, and the overridden headers cause them to be re-cached automatically.

---

## File structure

```
Assets-Cacher/
  manifest.json      MV3 manifest with declarativeNetRequest ruleset
  rules.json         Static DNR rule: override Cache-Control on static assets
  background.js      Service worker: cache hit/miss monitoring, per-site preferences, messaging
  popup.html/.js     Extension popup: per-site stats, enable/disable toggle
  popup.css          Shared styles for popup and options page
  options.html/.js   Options page: aggregate statistics dashboard
  icons/             Extension icons (16/48/128px)
```

---

## Installation

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project directory.

## Usage

1. Browse normally. The extension silently overrides cache headers on all static assets.
2. Click the extension icon to view per-site statistics and toggle caching.
3. Use `Ctrl+Shift+R` to force a fresh download if a site's assets appear stale.
4. Open the options page for aggregate bandwidth metrics.

---

## Permissions

| Permission | Usage |
|---|---|
| `storage` | Persist hit/miss statistics and per-site preferences |
| `declarativeNetRequest` | Apply static header-override rules and dynamic per-site exceptions |
| `declarativeNetRequestFeedback` | Required for dynamic rule updates |
| `webRequest` | Monitor `onCompleted` events to detect cache hits via `fromCache` |
| `tabs` | Read active tab URL for hostname-based badge and popup state |
| `<all_urls>` (host) | Apply header overrides across all origins |

---

## Limitations

- **Cache eviction is browser-managed.** Chrome's disk cache has a finite size (typically ~300MB–2GB depending on available disk space). When full, Chrome evicts least-recently-used entries automatically. The extension has no control over this.
- **Dynamic URLs.** Assets with cache-busting query strings (`?v=abc123`) are treated as unique URLs by the browser cache. If a site changes the hash on every deploy, the old cached version becomes orphaned and the new one is downloaded fresh.
- **HTML is excluded.** Only static asset types (stylesheets, scripts, images, fonts, media) are affected. HTML documents retain their original cache headers to avoid serving stale page content or breaking authentication flows.

## License

GPL-3.0. See [LICENSE](LICENSE).