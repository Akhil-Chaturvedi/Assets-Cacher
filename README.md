# Assets Cacher

A Chrome extension (Manifest V3) that overrides HTTP cache headers on static assets to extend their retention in Chrome's native disk cache. It uses `declarativeNetRequest` to replace the server's `Cache-Control` value on matching file types with a long-lived directive, causing Chrome to cache the file across sessions rather than revalidating on each page load.

---

## How it works

Many web servers return conservative cache headers (`Cache-Control: no-cache`, `max-age=0`, or `private`) on static assets, causing the browser to revalidate or re-download them on every page load. This extension uses Chrome's `declarativeNetRequest` API with a `modifyHeaders` action to replace `Cache-Control` on matching assets with:

```
Cache-Control: max-age=31536000
```

The `public` directive is intentionally omitted to avoid overriding `private` on responses from authenticated CDNs, which could leak cached responses between users on shared machines.

A second header is injected simultaneously:

```
X-Assets-Cacher-Forced: true
```

This acts as a fingerprint. On the initial download (cache miss), `background.js` detects this header and records the asset's `Content-Length` in an in-memory Map that is periodically flushed to `chrome.storage.local`. On subsequent visits, when Chrome serves the asset from disk (`fromCache: true`), the extension looks up the stored size and credits those bytes as bandwidth saved. This prevents the extension from taking credit for files that Chrome was already caching natively.

### Request flow

```
First visit:
  Browser -> Network -> Server responds with asset
  URL matches static regex (e.g. ends in .js, .css, .png):
    DNR injects: Cache-Control: max-age=31536000
    DNR injects: X-Assets-Cacher-Forced: true
    background.js sees miss + fingerprint ->
      stores Content-Length in memoryAssetSizes (synced to chrome.storage.local)
    Chrome disk cache stores asset

Subsequent visits:
  Browser -> Chrome disk cache (no full re-download)
  background.js sees fromCache: true + fingerprint ->
    looks up stored size -> logs as savings
```

### Targeting rules

The extension does not apply the override to all requests. `rules.json` uses a `regexFilter` mapped to DNR `resourceTypes`. It targets URLs ending in known static extensions, matched case-insensitively with `(?i)` (`.js`, `.css`, `.woff2`, `.ttf`, `.png`, `.jpg`, `.svg`, `.avif`, `.webp`, `.mp4`, etc.). Extensionless URLs are ignored by design. This reduces the surface area but does not eliminate it — see Limitations below.

### Why not IndexedDB or Service Worker interception?

Earlier iterations of this extension attempted to cache assets in IndexedDB and serve them via a Service Worker fetch handler, using DNR redirects to route requests through an internal proxy endpoint.

This approach failed for two reasons:
1. **Relative path corruption** — Redirecting a CDN-hosted CSS file to `chrome-extension://id/proxy.html` breaks all relative `url()` references inside the stylesheet. The browser resolves them against the extension origin instead of the original CDN.
2. **Double-fetch overhead** — The `webRequest.onCompleted` API fires after the browser has already consumed the response body. To populate IndexedDB, the extension had to issue a second `fetch()` for every new asset, doubling bandwidth on first visits.

The header-override approach avoids both problems. The browser handles storage, serving, and eviction natively.

---

## Architecture

### In-memory state with periodic flush

Network events modify in-memory `Map` instances synchronously (O(1) lookup/insert on the service worker thread). A `setInterval` daemon flushes the memory state to `chrome.storage` every 2 seconds, using `isDirty` flags to skip writes when nothing has changed. A `chrome.runtime.onSuspend` handler flushes pending data before the service worker is terminated, preventing data loss on SW lifecycle transitions.

### LRU eviction for asset sizes

The `memoryAssetSizes` Map holds up to 3000 entries. When the cap is exceeded, the oldest entry (by insertion order) is evicted. JavaScript `Map` preserves insertion order, and the code deletes-then-re-inserts accessed keys to maintain LRU ordering. The Map is serialized to `chrome.storage.local` on flush and re-hydrated on SW startup. Insertion order survives round-trip serialization under V8's string property enumeration guarantee (ES2015+).

### Hydration barrier

On service worker startup, storage is read asynchronously before any network events are processed. The `storageHydrated` promise gates all `webRequest.onCompleted` callbacks, preventing reads against uninitialized state.

### Per-site disable

Toggle caching off for a hostname from the popup. This adds a dynamic DNR rule with `action: "allow"` at priority 2, which overrides the static `modifyHeaders` rule at priority 1 for that domain. Rule IDs are allocated from an auto-incrementing counter starting at 10000 (the static rule uses id 1, so there is no collision). When a site is re-enabled, the allocator entry is garbage-collected.

### Bandwidth accounting caveats

The "bandwidth saved" metric uses `Content-Length` from the original response. For cache hits where the full response body was avoided, this is a reasonable approximation. However:
- If Chrome sends a conditional request (revalidation), the actual bytes saved are only the response headers, not the full body. The extension does not distinguish between fresh cache hits and revalidations.
- When `Content-Length` is absent (chunked transfer encoding), a size estimate based on file extension is used. These estimates are rough defaults (e.g., 100KB for JS, 250KB for images) and may not reflect actual asset sizes.

---

## File structure

```
Assets-Cacher/
  manifest.json          MV3 manifest with declarativeNetRequest ruleset and CSP
  rules.json             Static DNR rule: regexFilter-based Cache-Control injection
  background.js          Service worker: fingerprint tracking, session stats, per-site DNR exceptions
  popup.html/.js         Per-site stats, enable/disable toggle
  base.css               Shared styles (typography, components, toggle switch)
  popup.css              Popup-specific layout (280px width)
  options.html/.js       Aggregate bandwidth dashboard
  shared/utils.js        Shared utilities (formatBytes, abbreviateBadge)
  icons/                 Extension icons (16/48/128px)
```

---

## Installation

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked and select the project directory.

## Usage

1. Browse normally. The extension overrides cache headers on matching static assets.
2. Click the extension icon to view per-site hit count and bandwidth saved, and to toggle caching for that site.
3. Use `Ctrl+Shift+R` to force a fresh download if a site's assets appear stale. Chrome bypasses the disk cache on hard refresh; the extension re-injects headers on the fresh response, so the asset is re-cached with the long-lived directive.
4. Open the options page for aggregate session metrics.

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist cumulative bandwidth stats and per-site preferences |
| `declarativeNetRequest` | Apply the static header-override rule via `rules.json` and manage dynamic per-site exception rules |
| `webRequest` | Observe `onCompleted` events to detect `fromCache` hits and inspect the `X-Assets-Cacher-Forced` fingerprint |
| `tabs` | Read active tab URL for per-site badge and popup state |
| `<all_urls>` (host) | Apply header overrides across all origins |

---

## Limitations

- **Cache eviction is browser-managed.** Chrome's disk cache has a finite quota (typically a few hundred MB to a few GB depending on available disk space). When full, Chrome evicts least-recently-used entries. The extension has no control over this.
- **Un-hashed filenames.** If a site updates `app.js` without a cache-busting hash, the user gets the old version for up to a year unless they hard-refresh (`Ctrl+Shift+R`). Sites that use file hashing (`app.abc123.js`) are unaffected.
- **Session-scoped stats reset on browser close.** `chrome.storage.session` is cleared when the browser closes. Per-site hit counts and sizes reset. The cumulative `stats.bytesSaved` counter in `chrome.storage.local` persists across restarts.
- **Regex coverage is not exhaustive, and false positives exist.** Dynamic endpoints that happen to end in a static extension (e.g., `/api/data.js`) will receive the cache override. Such patterns can be excluded by disabling the extension for that hostname via the popup toggle.
- **Bandwidth estimates are approximate.** For chunked responses without `Content-Length`, the extension uses file-extension-based heuristics. These do not reflect actual asset sizes. Revalidation requests are counted as full cache hits, overestimating savings.
- **The webRequest listener fires for all URLs.** The `onCompleted` listener uses `<all_urls>` because `webRequest` URL filters do not support regex and glob patterns cannot match cache-busting query strings (e.g., `app.js?v=1.2.3`). The `X-Assets-Cacher-Forced` header check inside the handler filters to relevant requests, but the listener invocation itself adds overhead to every network request.

## License

GPL-3.0. See [LICENSE](LICENSE).
