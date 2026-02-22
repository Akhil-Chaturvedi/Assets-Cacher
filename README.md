# Assets Cacher

A Chrome extension (Manifest V3) that observes network traffic and maintains a local IndexedDB copy of static assets (images, scripts, stylesheets, fonts). It tracks cache hit/miss statistics per-session and persists asset metadata across browser restarts using lazy per-site loading.

> **Note**: This extension does not intercept or redirect requests. It operates as a passive observer and persistent cache layer alongside the browser's built-in HTTP cache.

---

## What it does

When you browse a website, the extension watches completed network requests via `chrome.webRequest.onCompleted`. For each successful GET request whose `Content-Type` is not in the disallowed list (HTML, JSON, XML, octet-stream), it:

1. Fetches the response body separately via `fetch()`
2. Compresses JS and CSS assets using `CompressionStream` (gzip)
3. Stores the full asset (as a data URL or compressed base64) in IndexedDB
4. Keeps lightweight metadata in an in-memory `siteCache` object

On subsequent requests to the same normalized URL, `onBeforeRequest` checks the in-memory metadata and records a hit.

## What it does not do

- It does **not** serve cached assets back to the page. The browser still makes its normal network requests. The extension is tracking and storing, not intercepting.
- It does **not** replace the browser's HTTP cache. It runs alongside it.
- Hit/miss statistics reflect whether the extension has previously *seen* an asset, not whether the browser served it from its own cache.

---

## Features

- **Per-site toggle**: Enable or disable caching on a per-hostname basis via the popup.
- **In-memory hit tracking**: `onBeforeRequest` checks asset URLs against the in-memory cache and records hits/misses to `chrome.storage.local`.
- **Lazy persistence**: On browser restart, the service worker's memory is cleared. When you visit a site, only that site's cached metadata is loaded from IndexedDB via the `initiator` index. No bulk load at startup.
- **gzip compression**: JS and CSS assets are compressed with `CompressionStream` before being stored in IndexedDB to reduce disk usage.
- **Cache eviction**: A configurable max-age policy (1/7/30 days, or unlimited) is checked hourly via `chrome.alarms`.
- **Stale detection**: Uses `ETag` and `Last-Modified` headers to skip re-caching unchanged assets.
- **Badge**: The extension icon shows the count of cached items for the active tab's hostname.
- **Options page**: Global stats (total items, total size, bandwidth saved), a visual cache inspector with type filters (images/scripts/styles/fonts), a detailed table view, and cache eviction settings.

---

## File structure

```
Assets-Cacher/
  manifest.json        # MV3 manifest; permissions: storage, webRequest, tabs, alarms, declarativeNetRequest
  background.js        # Service worker: request observation, caching logic, message handling
  db.js                # IndexedDB wrapper (assets store, initiator index, CRUD operations)
  popup.html / .js     # Extension popup: per-site stats, toggle, purge
  popup.css            # Shared styles for popup and options page
  options.html / .js   # Options page: global stats, cache inspector grid, eviction settings
  icons/               # Extension icons (16/48/128px)
```

## Architecture

```
                  onBeforeRequest                    onCompleted
  Browser -------> [check in-memory] -------> [fetch + store in IndexedDB]
  request          siteCache[host]              if new or stale asset
                   hit? -> recordHit()
                   miss? -> (no action)

  On site visit:   ensureSiteLoaded(host)
                   -> IndexedDB.getAll(initiator index, host)
                   -> populate siteCache[host]
```

**Storage layers:**

| Layer | Contents | Lifetime |
|---|---|---|
| `siteCache` (memory) | URL-keyed metadata (size, etag, content-type, timestamps) | Service worker lifetime + lazy reload from IndexedDB |
| IndexedDB `AssetCacheDB` | Full asset data (data URLs, compressed blobs) + metadata | Persistent until purged or evicted |
| `chrome.storage.local` | Stats (hits/misses/bytesSaved), site preferences, settings | Persistent |

---

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
5. Pin the extension icon for easy access.

## Usage

1. Navigate to any website.
2. Click the extension icon. The popup shows the current hostname, cached item count, and hit/miss stats.
3. Use the toggle to enable/disable caching for the current site.
4. Browse normally. Assets are cached in the background on first load.
5. Reload the page. You should see hits logged in the service worker console (`[Assets Cacher] HIT: ...`).
6. Click **Purge Cache for this Site** to clear cached data for the current hostname.
7. Open the options page (link at bottom of popup) to manage global settings and inspect cached assets.

---

## Known limitations

- **No request interception**: The extension cannot serve cached assets back to the page in MV3. It observes and stores, but the browser still fetches from the network (or its own HTTP cache). The "Bandwidth Saved" stat reflects what *would* have been saved if the cached copy were served, not actual bytes avoided.
- **Service worker lifecycle**: Chrome may terminate the service worker after ~30 seconds of inactivity. A keep-alive alarm runs every 24 seconds to mitigate this, but it is not guaranteed.
- **Dynamic URLs**: Sites that use cache-busting query parameters (random hashes, timestamps) will cause frequent misses. URL normalization is minimal (`origin + pathname + search`).
- **Double fetch**: Because `onCompleted` fires after the browser has already received the response, the extension does a second `fetch()` to get the body for storage. This means each new asset is effectively downloaded twice on first encounter.
- **Storage limits**: IndexedDB has no hard limit in Chrome, but very large caches (thousands of assets with data URLs) will consume significant disk space.

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist stats, site preferences, and settings |
| `webRequest` | Observe `onBeforeRequest` and `onCompleted` events |
| `tabs` | Read active tab URL for hostname-based cache lookups |
| `alarms` | Periodic cache eviction and service worker keep-alive |
| `declarativeNetRequest` | Declared in manifest (legacy, not currently used) |
| `<all_urls>` (host) | Observe requests to all origins |

## License

GPL-3.0. See [LICENSE](LICENSE).