// --- Assets Cacher Background Service Worker ---
import { openDB, setAsset, getAsset, getAllAssets, deleteAsset, clearAllAssets, getAssetsByInitiator } from './db.js';

// --- Data Structure (metadata only, no dataUrl in memory) ---
let siteCache = {};
let loadedSites = new Set(); // Track which sites have been loaded from IndexedDB

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
        return parsed.origin + parsed.pathname + parsed.search;
    } catch (e) {
        return url;
    }
}

// --- Lazy Loading: Load a site's cache from IndexedDB when first accessed ---
async function ensureSiteLoaded(hostname) {
    if (loadedSites.has(hostname)) {
        return; // Already loaded
    }

    console.log(`[Assets Cacher] Lazy loading cache for ${hostname}...`);
    loadedSites.add(hostname); // Mark as loading to prevent duplicate loads

    try {
        const assets = await getAssetsByInitiator(hostname);

        if (assets && assets.length > 0) {
            if (!siteCache[hostname]) {
                siteCache[hostname] = { totalSize: 0, assets: {} };
            }

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
    } catch (e) {
        console.error(`[Assets Cacher] Failed to load cache for ${hostname}:`, e);
    }
}

// --- Compression Helpers ---
async function compressData(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// --- Blob/DataURL Helpers ---
function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- Initialization & Alarms ---
chrome.runtime.onInstalled.addListener(() => {
    console.log("[Assets Cacher] onInstalled triggered");
    chrome.alarms.create('cacheEviction', { periodInMinutes: 60 });
    chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
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
        chrome.storage.local.get('_keepAlive');
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

                const url = normalizeUrl(details.url);
                const cachedMeta = siteCache[hostname]?.assets?.[url];

                if (cachedMeta) {
                    // Record hit asynchronously
                    recordHit(cachedMeta.size, url);
                }
            } catch (e) {
                // Ignore errors
            }
        })();
    },
    { urls: ["<all_urls>"] }
);

async function recordHit(size, url) {
    try {
        const { stats } = await chrome.storage.local.get('stats');
        const newStats = stats || { hits: 0, misses: 0, bytesSaved: 0 };
        newStats.hits++;
        newStats.bytesSaved += size;
        await chrome.storage.local.set({ stats: newStats });

        const { totalSavings } = await chrome.storage.local.get('totalSavings');
        await chrome.storage.local.set({ totalSavings: (totalSavings || 0) + size });

        if (size >= LARGE_ASSET_THRESHOLD) {
            chrome.runtime.sendMessage({
                type: 'largeAssetServed',
                url: url,
                size: size
            }).catch(() => { });
        }
        console.log(`[Assets Cacher] HIT: ${url.substring(0, 60)}...`);
    } catch (e) {
        console.error("[Assets Cacher] Error recording hit:", e);
    }
}

chrome.webRequest.onCompleted.addListener(
    (details) => {
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

        const response = await fetch(details.url);
        if (!response.ok) return;

        const blob = await response.blob();
        const sizeInBytes = blob.size;

        let dataUrl = await blobToDataURL(blob);
        let compressed = false;
        let compressedData = null;

        if (COMPRESSIBLE_TYPES.some(type => contentType.startsWith(type))) {
            try {
                const text = await blob.text();
                const compressedBuffer = await compressData(text);
                compressedData = arrayBufferToBase64(compressedBuffer);
                compressed = true;
                console.log(`[Assets Cacher] Compressed ${url.substring(0, 60)}...: ${sizeInBytes} -> ${compressedBuffer.byteLength} bytes`);
            } catch (e) {
                console.warn("[Assets Cacher] Compression failed:", e);
            }
        }

        const newAsset = {
            url,
            initiator: hostname,
            dataUrl,
            compressedData,
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

        // Track as a miss
        const { stats } = await chrome.storage.local.get('stats');
        const newStats = stats || { hits: 0, misses: 0, bytesSaved: 0 };
        newStats.misses++;
        await chrome.storage.local.set({ stats: newStats });

        // Update badge
        if (tabId !== -1) updateActionBadge(tabId);

        console.log(`[Assets Cacher] Cached: ${url.substring(0, 60)}... (${formatBytes(sizeInBytes)})`);
    } catch (e) {
        console.error(`[Assets Cacher] Failed to cache:`, e);
    }
}

// --- Communication ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[Assets Cacher] Message received:", message.type);

    handleMessage(message).then(response => {
        console.log("[Assets Cacher] Sending response");
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

        // Lazy load this site's cache
        await ensureSiteLoaded(hostname);

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
        return { dataUrl: asset?.dataUrl || null };
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
        loadedSites.delete(hostname);
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) updateActionBadge(tabs[0].id);
    }
}

async function purgeAllCache() {
    await clearAllAssets();
    siteCache = {};
    loadedSites.clear();
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