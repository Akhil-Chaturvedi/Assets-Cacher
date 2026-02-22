// --- Assets Cacher Background Service Worker ---
import { openDB, setAsset, getAsset, getAllAssets, deleteAsset, clearAllAssets, getAssetsByInitiator } from './db.js';

// --- Data Structure (metadata only, no blob in memory) ---
let siteCache = {};
let siteLoadPromises = new Map(); // Store promises to prevent concurrent DB loads
const MAX_SITES_IN_MEMORY = 30;

// --- Stats Batching ---
let pendingStats = { hits: 0, misses: 0, bytesSaved: 0 };
let statWriteTimer = null;

// --- Configuration ---
const DISALLOWED_CONTENT_TYPES = [
    "text/html", "application/json", "application/xml", "text/xml"
];
const COMPRESSIBLE_TYPES = ["application/javascript", "text/javascript", "text/css"];
const LARGE_ASSET_THRESHOLD = 500 * 1024; // 500KB

console.log("[Assets Cacher] Service worker starting...");

// --- DNR Utility ---
function hashUrlToId(url) {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
        hash = ((hash << 5) - hash) + url.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash) + 1; // DNR ID must be >= 1
}

async function loadDnrRulesForHost(hostname) {
    if (!hostname) return;

    // 1. Remove ALL existing dynamic rules to stay under 30k limit
    const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    const oldRuleIds = oldRules.map(r => r.id);

    // 2. Fetch all cached URLs for this specific host
    const assets = await getAssetsByInitiator(hostname);
    if (!assets || assets.length === 0) {
        if (oldRuleIds.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldRuleIds });
        }
        return;
    }

    // 3. Build new rule set (Capped at 29,000 just to be safe)
    const newRules = [];
    const maxRules = Math.min(assets.length, 29000);

    for (let i = 0; i < maxRules; i++) {
        const url = assets[i].rawUrl || assets[i].url;
        newRules.push({
            id: hashUrlToId(url),
            priority: 1,
            action: {
                type: 'redirect',
                redirect: { extensionPath: `/proxy.html?url=${encodeURIComponent(url)}` }
            },
            condition: {
                urlFilter: url,
                resourceTypes: ["stylesheet", "script", "image", "font", "media", "object", "other"]
            }
        });
    }

    // 4. Atomic swap (Remove old, add new)
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: oldRuleIds,
        addRules: newRules
    }).catch(e => console.error("[Assets Cacher] DNR Swap Error:", e));

    console.log(`[Assets Cacher] Loaded ${newRules.length} DNR rules for ${hostname}`);
}

async function updateDnrRule(url) {
    // Only add a new rule dynamically if we have room. 
    // Usually, loadDnrRulesForHost handles the bulk load on navigation.
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    if (rules.length >= 29000) return;

    const id = hashUrlToId(url);
    const extensionPath = `/proxy.html?url=${encodeURIComponent(url)}`;

    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [id],
        addRules: [{
            id: id,
            priority: 1,
            action: {
                type: 'redirect',
                redirect: { extensionPath }
            },
            condition: {
                urlFilter: url,
                resourceTypes: ["stylesheet", "script", "image", "font", "media", "object", "other"]
            }
        }]
    }).catch((e) => { });
}

async function removeDnrRule(url) {
    const id = hashUrlToId(url);
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [id]
    }).catch((e) => { });
}

// --- Service Worker Fetch Intercept ---
self.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);

    // We only care about requests to our proxy endpoint
    if (requestUrl.pathname === '/proxy.html') {
        const targetUrl = requestUrl.searchParams.get('url');
        if (!targetUrl) return;

        event.respondWith((async () => {
            try {
                // Hard Refresh Bypass (Ctrl+Shift+R)
                if (event.request.cache === 'reload' || event.request.cache === 'no-cache' ||
                    event.request.headers.get('Cache-Control') === 'no-cache') {
                    console.log(`[Assets Cacher] Hard Refresh detected, bypassing cache for ${targetUrl}`);
                    return fetch(targetUrl, { cache: 'no-store' }); // Let the normal onCompleted listener catch and update it!
                }

                // Determine if site is disabled
                const hostname = new URL(targetUrl).hostname;
                const { site_prefs } = await chrome.storage.local.get('site_prefs');
                if ((site_prefs || {})[hostname]?.enabled === false) {
                    return fetch(targetUrl, { mode: 'no-cors' }); // Fallback to network
                }

                const asset = await getAsset(targetUrl);

                if (asset && asset.blob) {
                    console.log(`[Assets Cacher] SW HIT: ${targetUrl.substring(0, 60)}...`);
                    queueStatUpdate('hit', asset.size, targetUrl);

                    // 24 Hour Stale-While-Revalidate Logic
                    const now = Date.now();
                    const lastValidated = asset.lastValidated || asset.cachedOn;
                    const oneDayMs = 24 * 60 * 60 * 1000;

                    if (now - lastValidated > oneDayMs) {
                        event.waitUntil((async () => {
                            try {
                                const headers = {};
                                if (asset.etag) headers['If-None-Match'] = asset.etag;
                                if (asset.lastModified) headers['If-Modified-Since'] = asset.lastModified;

                                // Fetch silently in background
                                const response = await fetch(targetUrl, { headers });

                                if (response.status === 200) {
                                    // Asset has updated! Download new version quietly
                                    const blob = await response.blob();
                                    asset.blob = blob;
                                    asset.cachedOn = Date.now();
                                    asset.lastAccessed = Date.now();
                                    asset.lastValidated = Date.now();
                                    await setAsset(asset);
                                    console.log(`[Assets Cacher] SW Updated asset in background: ${targetUrl.substring(0, 60)}...`);
                                } else if (response.status === 304) {
                                    // Not modified, just touch last accessed
                                    asset.lastAccessed = Date.now();
                                    asset.lastValidated = Date.now();
                                    await setAsset(asset);
                                }
                            } catch (e) {
                                // Offline or network error during SWR, ignore
                            }
                        })());
                    } else {
                        // Skip validation, just bump access time in memory
                        asset.lastAccessed = Date.now();
                        setAsset(asset).catch(() => { }); // fire and forget
                    }

                    // Serve from cache immediately!
                    return new Response(asset.blob, {
                        headers: {
                            'Content-Type': asset.contentType,
                            'Cache-Control': 'public, max-age=3153600'
                        }
                    });
                }
            } catch (e) {
                console.error("[Assets Cacher] Fetch handler error:", e);
            }

            // Fallback: If anything fails or not in DB, fetch from network directly
            return fetch(targetUrl, { mode: 'no-cors' });
        })());
    }
});

// --- URL Normalization ---
function normalizeUrl(url) {
    try {
        const parsed = new URL(url);
        // Strip common tracking parameters to improve cache hit rate
        const params = new URLSearchParams(parsed.search);
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach(p => params.delete(p));
        parsed.search = params.toString();
        return parsed.origin + parsed.pathname + parsed.search;
    } catch (e) {
        return url;
    }
}

// --- LRU Cache Update ---
function updateLRU(hostname) {
    if (siteCache[hostname]) {
        // Move to the back by deleting and re-inserting
        const data = siteCache[hostname];
        delete siteCache[hostname];
        siteCache[hostname] = data;
    }

    // Evict oldest if we exceed limit
    const keys = Object.keys(siteCache);
    if (keys.length > MAX_SITES_IN_MEMORY) {
        const oldestHost = keys[0];
        delete siteCache[oldestHost];
        siteLoadPromises.delete(oldestHost);
    }
}

// --- Lazy Loading: Load a site's cache from IndexedDB when first accessed ---
function ensureSiteLoaded(hostname) {
    if (siteLoadPromises.has(hostname)) {
        updateLRU(hostname);
        return siteLoadPromises.get(hostname);
    }

    console.log(`[Assets Cacher] Lazy loading cache for ${hostname}...`);

    const promise = (async () => {
        try {
            const assets = await getAssetsByInitiator(hostname);

            if (!siteCache[hostname]) {
                siteCache[hostname] = { totalSize: 0, assets: {} };
            }

            if (assets && assets.length > 0) {
                for (const asset of assets) {
                    if (!asset || !asset.url) continue;

                    siteCache[hostname].assets[asset.url] = {
                        url: asset.url,
                        initiator: asset.initiator,
                        size: asset.size,
                        etag: asset.etag,
                        lastModified: asset.lastModified,
                        cachedOn: asset.cachedOn,
                        lastAccessed: asset.lastAccessed,
                        contentType: asset.contentType,
                        compressed: asset.compressed
                    };
                    siteCache[hostname].totalSize += asset.size;
                }
                console.log(`[Assets Cacher] Loaded ${assets.length} cached assets for ${hostname}`);
            }
            updateLRU(hostname);
        } catch (e) {
            console.error(`[Assets Cacher] Failed to load cache for ${hostname}:`, e);
            siteLoadPromises.delete(hostname); // Allow retry on failure
        }
    })();

    siteLoadPromises.set(hostname, promise);
    return promise;
}

// --- Compression Helpers ---
// Removed compression as it wastes CPU for assets not sent back via HTTP.
// Blobs are stored efficiently in LevelDB by Chrome locally.
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- Stats Batching System ---
function queueStatUpdate(type, size = 0, url = null) {
    // Only missed items trigger misses now, hits are triggered via the SW fetch intercept
    if (type === 'hit') pendingStats.hits++;
    if (type === 'miss') pendingStats.misses++;
    pendingStats.bytesSaved += size;

    if (type === 'hit' && size >= LARGE_ASSET_THRESHOLD && url) {
        chrome.runtime.sendMessage({
            type: 'largeAssetServed',
            url: url,
            size: size
        }).catch(() => { });
    }

    if (!statWriteTimer) {
        statWriteTimer = setTimeout(flushStats, 2000);
    }
}

async function flushStats() {
    statWriteTimer = null;
    const toSave = { ...pendingStats };
    pendingStats = { hits: 0, misses: 0, bytesSaved: 0 };

    if (toSave.hits === 0 && toSave.misses === 0 && toSave.bytesSaved === 0) return;

    try {
        const data = await chrome.storage.local.get(['stats', 'totalSavings']);
        const stats = data.stats || { hits: 0, misses: 0, bytesSaved: 0 };
        const totalSavings = data.totalSavings || 0;

        stats.hits += toSave.hits;
        stats.misses += toSave.misses;
        stats.bytesSaved += toSave.bytesSaved;

        await chrome.storage.local.set({
            stats: stats,
            totalSavings: totalSavings + toSave.bytesSaved
        });
    } catch (e) {
        // If it fails, put stats back into pending
        pendingStats.hits += toSave.hits;
        pendingStats.misses += toSave.misses;
        pendingStats.bytesSaved += toSave.bytesSaved;
        if (!statWriteTimer) statWriteTimer = setTimeout(flushStats, 2000);
    }
}

// --- Initialization & Alarms ---
chrome.runtime.onInstalled.addListener(() => {
    console.log("[Assets Cacher] onInstalled triggered");
    chrome.alarms.create('cacheEviction', { periodInMinutes: 60 });
    chrome.action.setBadgeBackgroundColor({ color: '#2d2d2d' });

    // Ensure session storage handles keeps the keep-alives natively now 
    // Wait, let's keep it simple and just rely on webRequest events to keep SW active.

    chrome.storage.local.get(['stats'], (data) => {
        if (!data.stats) {
            chrome.storage.local.set({
                stats: { hits: 0, misses: 0, bytesSaved: 0 }
            });
        }
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'cacheEviction') {
        evictOldCache();
    }
});

// --- Badge Logic ---
async function updateActionBadge(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.url && tab.url.startsWith('http')) {
            const hostname = new URL(tab.url).hostname;
            await ensureSiteLoaded(hostname); // Lazy load this site's cache
            const count = siteCache[hostname] ? Object.keys(siteCache[hostname].assets).length : 0;
            chrome.action.setBadgeText({ tabId, text: count > 0 ? count.toString() : '' });
        } else {
            chrome.action.setBadgeText({ tabId, text: '' });
        }
    } catch (e) { /* Tab may be closed */ }
}

chrome.tabs.onActivated.addListener((activeInfo) => updateActionBadge(activeInfo.tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
        updateActionBadge(tabId);
        if (tab.url && tab.url.startsWith('http')) {
            const hostname = new URL(tab.url).hostname;
            loadDnrRulesForHost(hostname);
        }
    }
});

// --- Caching Logic ---
// Removed onBeforeRequest since DNR handles the hits natively via redirects directly to our SW.

chrome.webRequest.onCompleted.addListener(
    (details) => {
        // Avoid intercepting our own proxy fetches or web-accessible requests
        if (details.url.startsWith('chrome-extension://')) return;

        // Optimization: skip if served directly from browser cache
        if (details.fromCache) return;

        if (details.method !== "GET" || details.statusCode !== 200) return;

        const contentTypeHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type');
        const contentType = contentTypeHeader?.value || '';

        if (!DISALLOWED_CONTENT_TYPES.some(type => contentType.startsWith(type))) {
            validateAndCacheAsset(details, contentType);
        }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
);

async function validateAndCacheAsset(details, contentType) {
    try {
        const { initiator, tabId } = details;
        const rawUrl = details.url;
        const url = normalizeUrl(rawUrl);

        // Let's avoid recursive loops on data/blob urls or proxies
        if (!url.startsWith('http')) return;

        // Extract hostname safely
        let hostname;
        try {
            hostname = new URL(initiator || url).hostname;
        } catch (e) { return; }

        // Ensure site cache is loaded
        await ensureSiteLoaded(hostname);
        updateLRU(hostname);

        const { site_prefs } = await chrome.storage.local.get('site_prefs');
        if ((site_prefs || {})[hostname]?.enabled === false) return;

        const etag = details.responseHeaders?.find(h => h.name.toLowerCase() === 'etag')?.value || '';
        const lastModified = details.responseHeaders?.find(h => h.name.toLowerCase() === 'last-modified')?.value || '';
        const existingAsset = siteCache[hostname]?.assets?.[url];

        // If we already have this exact version cached, just update last accessed
        if (existingAsset &&
            ((existingAsset.etag && existingAsset.etag === etag) ||
                (existingAsset.lastModified && existingAsset.lastModified === lastModified))) {
            existingAsset.lastAccessed = Date.now();
            return;
        }

        let response;
        try {
            response = await fetch(rawUrl);
            if (!response.ok) return;
        } catch (e) {
            // CORS or network failure
            console.warn(`[Assets Cacher] Fetch failed for ${url.substring(0, 60)}...`);
            return;
        }

        const blob = await response.blob();
        const sizeInBytes = blob.size;

        const newAsset = {
            url,
            rawUrl, // Store raw URL to use in DNR conditions
            initiator: hostname,
            blob: blob, // Native Blob storage
            compressed: false, // Retired compression
            contentType,
            size: sizeInBytes,
            etag,
            lastModified,
            cachedOn: Date.now(),
            lastAccessed: Date.now(),
            lastValidated: Date.now()
        };

        // Store in IndexedDB (don't await - fire and forget)
        setAsset(newAsset).catch(e => console.error("[Assets Cacher] DB write error:", e));

        // Tell DNR to intercept this exact rawURL on future navigations!
        await updateDnrRule(rawUrl);

        // Update in-memory cache immediately
        if (!siteCache[hostname]) siteCache[hostname] = { totalSize: 0, assets: {} };
        if (existingAsset) siteCache[hostname].totalSize -= existingAsset.size;

        siteCache[hostname].assets[url] = {
            url,
            initiator: hostname,
            size: sizeInBytes,
            etag,
            lastModified,
            cachedOn: newAsset.cachedOn,
            lastAccessed: newAsset.lastAccessed,
            contentType,
            compressed: false
        };
        siteCache[hostname].totalSize += sizeInBytes;

        queueStatUpdate('miss');

        // Update badge
        if (tabId !== -1) updateActionBadge(tabId);

        console.log(`[Assets Cacher] Cached + DNR Intercept Set: ${url.substring(0, 60)}...`);
    } catch (e) {
        console.error(`[Assets Cacher] Failed to cache:`, e);
    }
}

// --- Communication ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Return early if handling message promises
    handleMessage(message).then(response => {
        sendResponse(response);
    }).catch(e => {
        console.error("[Assets Cacher] Message handler error:", e);
        sendResponse({ error: e.message });
    });

    return true;
});

async function handleMessage(message) {
    if (message.type === 'getState') {
        const { hostname } = message;
        await ensureSiteLoaded(hostname);

        // Ensure pending stats are flushed so UI is accurate
        if (statWriteTimer) {
            clearTimeout(statWriteTimer);
            await flushStats();
        }

        const data = await chrome.storage.local.get(['site_prefs', 'totalSavings', 'stats']);
        const sitePrefs = data.site_prefs || {};
        const isEnabled = sitePrefs[hostname]?.enabled !== false;
        const cacheData = siteCache[hostname];
        const stats = data.stats || { hits: 0, misses: 0, bytesSaved: 0 };

        return {
            isEnabled,
            itemCount: cacheData ? Object.keys(cacheData.assets).length : 0,
            totalSize: cacheData ? cacheData.totalSize : 0,
            savings: data.totalSavings || 0,
            stats
        };
    } else if (message.type === 'toggleSite') {
        const { hostname, enabled } = message;
        const { site_prefs } = await chrome.storage.local.get('site_prefs');
        const newPrefs = site_prefs || {};
        if (!newPrefs[hostname]) newPrefs[hostname] = {};
        newPrefs[hostname].enabled = enabled;
        await chrome.storage.local.set({ site_prefs: newPrefs });
        // Instead of purging disabled site's cache, it simply bypassed in SW 'fetch' now
        return { success: true };
    } else if (message.type === 'purgeSiteCache') {
        await purgeSiteCache(message.hostname);
        return { success: true };
    } else if (message.type === 'getGlobalStats') {
        if (statWriteTimer) {
            clearTimeout(statWriteTimer);
            await flushStats();
        }
        const { totalSavings, stats } = await chrome.storage.local.get(['totalSavings', 'stats']);
        let totalItems = 0;
        let totalSize = 0;
        for (const host in siteCache) {
            totalItems += Object.keys(siteCache[host].assets).length;
            totalSize += siteCache[host].totalSize;
        }
        return {
            totalSavings: totalSavings || 0,
            totalItems,
            totalSize,
            stats: stats || { hits: 0, misses: 0, bytesSaved: 0 }
        };
    } else if (message.type === 'getAllAssets') {
        const allAssets = [];
        for (const host in siteCache) {
            for (const url in siteCache[host].assets) {
                allAssets.push({ ...siteCache[host].assets[url] });
            }
        }
        return allAssets;
    } else if (message.type === 'getAssetPreview') {
        return { hasAsset: true }; // Options handles blob load
    } else if (message.type === 'purgeAll') {
        await purgeAllCache();
        return { success: true };
    } else if (message.type === 'resetStats') {
        await chrome.storage.local.set({
            stats: { hits: 0, misses: 0, bytesSaved: 0 }
        });
        return { success: true };
    }

    return { error: 'Unknown message type' };
}

// --- Cache Management Functions ---
async function purgeSiteCache(hostname) {
    if (siteCache[hostname]) {
        for (const url in siteCache[hostname].assets) {
            // IMPORTANT: Remove DNR intercept!
            const assetRawUrl = siteCache[hostname].assets[url].rawUrl || url;
            await removeDnrRule(assetRawUrl);
            await deleteAsset(url);
        }
        delete siteCache[hostname];
        siteLoadPromises.delete(hostname);
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) updateActionBadge(tabs[0].id);
    }
}

async function purgeAllCache() {
    await clearAllAssets();

    // Clear all DNR rules
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = rules.map(r => r.id);
    if (ids.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    }

    siteCache = {};
    siteLoadPromises.clear();
    await chrome.storage.local.set({
        totalSavings: 0,
        stats: { hits: 0, misses: 0, bytesSaved: 0 }
    });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) updateActionBadge(tabs[0].id);
}

async function evictOldCache() {
    const { settings } = await chrome.storage.local.get('settings');
    const maxAgeDays = settings?.maxAge;
    if (!maxAgeDays || maxAgeDays === 0) return;

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let itemsEvicted = 0;

    for (const host in siteCache) {
        for (const url in siteCache[host].assets) {
            const asset = siteCache[host].assets[url];
            if (now - asset.cachedOn > maxAgeMs) {
                // Remove DNR Intercept
                const assetRawUrl = asset.rawUrl || url;
                await removeDnrRule(assetRawUrl);

                await deleteAsset(url);
                delete siteCache[host].assets[url];
                siteCache[host].totalSize -= asset.size;
                itemsEvicted++;
            }
        }
    }

    if (itemsEvicted > 0) {
        console.log(`[Assets Cacher] Evicted ${itemsEvicted} old items.`);
    }
}

console.log("[Assets Cacher] Service worker initialized.");