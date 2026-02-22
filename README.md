# Assets Cacher

A Chrome extension (Manifest V3) that natively intercepts network traffic and serves static assets (images, scripts, stylesheets, fonts) directly from an offline IndexedDB cache, saving you real bandwidth. It tracks cache hit/miss statistics per-session and persists asset metadata across browser restarts using lazy per-site loading.

---

## What makes this unique?

Under Manifest V3, Chrome completely banned extensions from using the blocking WebRequest API to intercept and fulfill network requests out of thin air. Most caching extensions broke or were forced to become passive analytics trackers.

**Assets Cacher bypasses this limitation** by combining two modern APIs:
1. **Declarative Net Request (DNR)**: When the extension caches a file, it registers a dynamic DNR rule telling Chrome: *"If the browser asks for this URL again, silently redirect the request to our extension's internal proxy endpoint."*
2. **Service Worker Fetch Listener**: The extension's background script intercepts requests directed at its internal proxy endpoint, reads the raw `Blob` natively from IndexedDB, and serves it back to the page instantly. 

**Result:** True **0-byte** offline cache hits that completely bypass your ISP, even on Manifest V3.

---

## Features

- **True Offline Caching**: Zero internet bandwidth is consumed for cached assets. The browser is natively redirected to a local proxy.
- **Stale-While-Revalidate**: When the extension serves a cached file, it silently pings the server in the background (using `If-Modified-Since` and `ETag`). If the server has a newer version, the extension quietly downloads it and overwrites the cache so your next visit is seamless.
- **Native Blob Storage**: Assets are stored natively as binary `Blob` objects inside IndexedDB. No wasteful Base64 encoding.
- **Memory Safe**: The in-memory cache enforces a strict 30-site LRU (Least Recently Used) limit, gracefully managing RAM on long browsing sessions.
- **Per-site toggle**: Enable or disable caching on a per-hostname basis via the popup.
- **Badge**: The extension icon shows the count of cached items for the active tab's hostname.
- **Options page**: Global stats (total items, total size, bandwidth saved), a visual cache inspector with type filters (images/scripts/styles/fonts), a detailed table view, and cache eviction settings.

---

## File structure

```
Assets-Cacher/
  manifest.json        # MV3 manifest; permissions: storage, webRequest, tabs, alarms, declarativeNetRequest
  background.js        # Service worker: request observation, DNR rule creation, SW Fetch intercept
  db.js                # IndexedDB wrapper (native Blob storage, initiator index)
  proxy.html           # Dummy endpoint used strictly to trigger the SW Fetch intercept
  popup.html / .js     # Extension popup: per-site stats, toggle, purge
  popup.css            # Shared styles for popup and options page
  options.html / .js   # Options page: global stats, cache inspector grid, eviction settings
  icons/               # Extension icons (16/48/128px)
```

## Architecture

```
  Visit 1: Initial Download
  Browser -------> [downloads abc.js natively]
                   onCompleted fires -> Extension issues fetch() -> Stores Blob in DB
                   DNR Rule created: "Redirect abc.js to /proxy?url=abc.js"

  Visit 2: Offline Cache Hit
  Browser -------> [requests abc.js]
  DNR Intercept -> [redirects to /proxy?url=abc.js]
  SW Fetch      -> [reads Blob from DB] -> [Serves Blob instantly] 
                   [Silently revalidates ETags in background]
```

**Storage layers:**

| Layer | Contents | Lifetime |
|---|---|---|
| `siteCache` (memory) | URL-keyed metadata (size, etag, content-type, timestamps) | Strict 30-site LRU limit |
| IndexedDB `AssetCacheDB` | Full asset data (native Blobs) + metadata | Persistent until purged or evicted |
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
5. Reload the page. You should see hits logged in the service worker console (`[Assets Cacher] SW HIT: ...`).
6. Click **Purge Cache for this Site** to clear cached data (and DNR rules) for the current hostname.
7. Open the options page (link at bottom of popup) to manage global settings and inspect cached assets.

---

## Known limitations

- **Double fetch on 1st visit**: Because `onCompleted` fires after the browser has already received the response, the extension must do a second `fetch()` to get the body for the initial storage. This means each new asset is downloaded twice on the *first* encounter. It pays off on the second visit!
- **Dynamic URLs**: Sites that use cache-busting query parameters (random hashes, timestamps) will cause frequent misses. URL normalization strips common tracking parameters (like `utm_source`), but complex dynamic URLs are still hard to predict.
- **Service worker lifecycle**: Chrome suspends background workers after inactivity, but the SW will automatically wake back up to handle `fetch` events when the DNR redirects fire.

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist stats, site preferences, and settings |
| `webRequest` | Observe `onCompleted` to index new resources |
| `declarativeNetRequest` | Dynamically generate proxy redirection rules |
| `tabs` | Read active tab URL for hostname-based cache lookups |
| `alarms` | Periodic old cache eviction check (runs every 60 min) |
| `<all_urls>` (host) | Observe and intercept requests to all origins |

## License

GPL-3.0. See [LICENSE](LICENSE).