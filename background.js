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
    "text/html", "application/json", "application/xml", "text/xml", "application/octet-stream"
];
const COMPRESSIBLE_TYPES = ["application/javascript", "text/javascript", "text/css"];
const LARGE_ASSET_THRESHOLD = 500 * 1024; // 500KB

console.log("[Assets Cacher] Service worker starting...");

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
async function compressData(text, contentType) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressedBuffer = await new Response(stream).arrayBuffer();
    return new Blob([compressedBuffer], { type: contentType });
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- Stats Batching System ---
function queueStatUpdate(type, size = 0, url = null) {
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
    chrome.alarms.create('keepAlive', { periodInMinutes: 1.0 }); // Min is 1 minute
    chrome.action.setBadgeBackgroundColor({ color: '#2d2d2d' });

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
    } else if (alarm.name === 'keepAlive') {
        // Keeps the service worker alive by querying storage
        chrome.storage.local.get('_keepAlive');
        // Force flush stats just in case SW is about to die
        if (statWriteTimer) {
            clearTimeout(statWriteTimer);
            flushStats();
        }
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
    if (changeInfo.status === 'complete' && tab.active) updateActionBadge(tabId);
});

// --- Caching Logic ---
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.method !== "GET") return;
        const initiator = details.initiator;
        if (!initiator || !initiator.startsWith('http')) return;

        // Process asynchronously
        (async () => {
            try {
                const hostname = new URL(initiator).hostname;

                // Lazy load this site's cache from IndexedDB
                await ensureSiteLoaded(hostname);

                // We update LRU here to keep the site active in memory
                updateLRU(hostname);

                const url = normalizeUrl(details.url);
                const cachedMeta = siteCache[hostname]?.assets?.[url];

                if (cachedMeta) {
                    console.log(`[Assets Cacher] HIT: ${url.substring(0, 60)}...`);
                    queueStatUpdate('hit', cachedMeta.size, url);
                }
            } catch (e) {
                // Ignore errors
            }
        })();
    },
    { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
    (details) => {
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
        const url = normalizeUrl(details.url);

        if (!initiator || !initiator.startsWith('http')) return;

        const hostname = new URL(initiator).hostname;

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
            response = await fetch(details.url);
            if (!response.ok) return;
        } catch (e) {
            // CORS or network failure
            console.warn(`[Assets Cacher] Fetch failed for ${url.substring(0, 60)}... (CORS or Network Error)`);
            return;
        }

        const blob = await response.blob();
        const sizeInBytes = blob.size;

        let compressed = false;
        let finalBlob = blob;

        if (COMPRESSIBLE_TYPES.some(type => contentType.startsWith(type))) {
            try {
                const text = await blob.text();
                finalBlob = await compressData(text, contentType);
                compressed = true;
                console.log(`[Assets Cacher] Compressed ${url.substring(0, 60)}...: ${sizeInBytes} -> ${finalBlob.size} bytes`);
            } catch (e) {
                console.warn("[Assets Cacher] Compression failed:", e);
                finalBlob = blob;
            }
        }

        const newAsset = {
            url,
            initiator: hostname,
            blob: finalBlob, // Native Blob storage
            compressed,
            contentType,
            size: sizeInBytes,
            etag,
            lastModified,
            cachedOn: Date.now(),
            lastAccessed: Date.now()
        };

        // Store in IndexedDB (don't await - fire and forget)
        setAsset(newAsset).catch(e => console.error("[Assets Cacher] DB write error:", e));

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
            compressed
        };
        siteCache[hostname].totalSize += sizeInBytes;

        queueStatUpdate('miss');

        // Update badge
        if (tabId !== -1) updateActionBadge(tabId);

        console.log(`[Assets Cacher] Cached: ${url.substring(0, 60)}... (${formatBytes(sizeInBytes)})`);
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
        if (!enabled) await purgeSiteCache(message.hostname);
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
        const asset = await getAsset(message.url);
        // We will return true if asset exists. The UI will have to create Object URL
        // Unfortunately MV3 background service workers cannot create Object URLs!
        // So we will just pass the Blob to the popup if possible? No, we can't pass blobs across message channels.
        // Oh wait, MV3 cannot use Blob URLs locally in SW anyway.
        // But options page is a normal DOM page, it can create Object URLs!
        return {
            hasAsset: !!asset,
            // Since we can't send Blob over chrome messages easily if it's too big, 
            // actually we can send Blobs but maybe it's better to fetch from DB on the client side?
            // Wait, we can't send Blob over postMessage? Actually chrome.runtime.sendMessage can send Blobs!
            // BUT sending 1MB array down the message channel is slow.
            // Wait, I can send the blob directly.
            // However, previous version sent a Base64 string dataUrl! So string worked.
            // Let's just return the asset. The popup/options can do what they need.
        };
    } else if (message.type === 'getAssetBlob') {
        // We probably cannot send exact Blob object efficiently, but let's try.
        // Wait, sending Blob over sendMessage works but might be serialized.
        const asset = await getAsset(message.url);
        if (asset && asset.blob) {
            // Convert to base64 ONLY on demand for the preview!
            const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(asset.blob);
            });
            return { dataUrl: base64 };
        }
        return { dataUrl: null };
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