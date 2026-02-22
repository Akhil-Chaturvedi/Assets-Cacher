// --- Background: Cache hit/miss monitoring ---

console.log("[Assets Cacher] V3 Monitor starting.");

// -- State (In-Memory Maps to prevent I/O thrashing) --
const memoryAssetSizes = new Map(); // LRU Cache for precise asset sizes
const memoryHostStats = new Map();  // Session stats per hostname
const memoryTabBadges = new Map();  // Pending badge updates

let pendingGlobalStats = { hits: 0, misses: 0, bytesSaved: 0 };

// -- LRU Cache Configuration --
const MAX_ASSET_MEMORY = 3000;

// -- Initialization --
chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeBackgroundColor({ color: '#2d2d2d' });
    chrome.storage.local.get(['stats', 'nextRuleId', 'assetSizes'], (data) => {
        if (!data.stats) {
            chrome.storage.local.set({ stats: { hits: 0, misses: 0, bytesSaved: 0 } });
        }
        if (!data.nextRuleId) {
            chrome.storage.local.set({ nextRuleId: 10000 });
        }
        if (data.assetSizes) {
            // Restore asset sizes from previous session
            for (const [url, size] of Object.entries(data.assetSizes)) {
                memoryAssetSizes.set(url, size);
            }
        }
    });
});

// Load asset sizes on Service Worker wake
chrome.storage.local.get(['assetSizes'], (data) => {
    if (data.assetSizes) {
        for (const [url, size] of Object.entries(data.assetSizes)) {
            memoryAssetSizes.set(url, size);
        }
    }
});
chrome.storage.session.get(['siteStats'], (data) => {
    if (data.siteStats) {
        for (const [host, stats] of Object.entries(data.siteStats)) {
            memoryHostStats.set(host, stats);
        }
    }
});

// -- Utility: LRU Insertion --
function storeAssetSize(url, size) {
    if (memoryAssetSizes.has(url)) {
        memoryAssetSizes.delete(url);
    }
    memoryAssetSizes.set(url, size);
    if (memoryAssetSizes.size > MAX_ASSET_MEMORY) {
        // Map iterates in insertion order, so the first is the oldest (Least Recently Used)
        const oldestKey = memoryAssetSizes.keys().next().value;
        memoryAssetSizes.delete(oldestKey);
    }
}

// -- Utility: Size Estimation Heuristic --
// Used when chunked-transfer hides Content-Length, or when the user resets the dashboard
// but files remain in the native disk cache.
function estimateAssetSize(url) {
    const extMatch = url.match(/\.(js|css|woff2?|png|jpe?g|svg|mp4|webm|gif|ico)(\?.*)?$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    if (ext === 'js') return 50 * 1024;
    if (ext === 'css') return 25 * 1024;
    if (ext.startsWith('woff') || ext === 'ttf') return 80 * 1024;
    if (ext === 'png' || ext.startsWith('jpg') || ext === 'webp') return 150 * 1024;
    if (ext === 'svg' || ext === 'ico') return 10 * 1024;
    if (ext === 'mp4' || ext === 'webm') return 2 * 1024 * 1024;
    return 30 * 1024;
}

// -- Flush Daemon (Runs every 2000ms) --
// This solves the O(N) I/O Thrashing and UI Jank by batching everything locally.
setInterval(async () => {
    // 1. Flush Global Stats to Local Storage
    const toSaveGlobal = { ...pendingGlobalStats };
    pendingGlobalStats = { hits: 0, misses: 0, bytesSaved: 0 };

    if (toSaveGlobal.hits > 0 || toSaveGlobal.misses > 0 || toSaveGlobal.bytesSaved > 0) {
        try {
            const data = await chrome.storage.local.get(['stats', 'totalSavings']);
            const stats = data.stats || { hits: 0, misses: 0, bytesSaved: 0 };
            const totalSavings = data.totalSavings || 0;

            stats.hits += toSaveGlobal.hits;
            stats.misses += toSaveGlobal.misses;
            stats.bytesSaved += toSaveGlobal.bytesSaved;

            await chrome.storage.local.set({
                stats: stats,
                totalSavings: totalSavings + toSaveGlobal.bytesSaved
            });
        } catch (e) {
            // Revert on failure
            pendingGlobalStats.hits += toSaveGlobal.hits;
            pendingGlobalStats.misses += toSaveGlobal.misses;
            pendingGlobalStats.bytesSaved += toSaveGlobal.bytesSaved;
        }
    }

    // 2. Flush Asset Sizes to Local Storage (Survives browser restarts)
    if (memoryAssetSizes.size > 0) {
        const sizesObj = {};
        for (const [k, v] of memoryAssetSizes) sizesObj[k] = v;
        await chrome.storage.local.set({ assetSizes: sizesObj });
    }

    // 3. Flush Host Stats to Session Storage
    if (memoryHostStats.size > 0) {
        const hostStatsObj = {};
        for (const [k, v] of memoryHostStats) hostStatsObj[k] = v;
        await chrome.storage.session.set({ siteStats: hostStatsObj });
    }

    // 4. Flush UI Badges
    if (memoryTabBadges.size > 0) {
        for (const [tabId, hostname] of memoryTabBadges) {
            try {
                const stats = memoryHostStats.get(hostname);
                if (stats && stats.items > 0) {
                    chrome.action.setBadgeText({ tabId, text: stats.items.toString() });
                }
            } catch (e) { }
        }
        memoryTabBadges.clear();
    }
}, 2000);

// -- Per-site exceptions via dynamic DNR rules --
const ASSET_TYPES = ["stylesheet", "script", "image", "font", "media", "object"];

async function applySitePreferences() {
    const data = await chrome.storage.local.get(['site_prefs', 'rule_allocator', 'nextRuleId']);
    const site_prefs = data.site_prefs || {};
    const rule_allocator = data.rule_allocator || {};
    let nextRuleId = data.nextRuleId || 10000;

    let allocatorChanged = false;

    const disabledDomains = [];
    const ruleIdsToRemove = [];

    // Get current active dynamic rules to remove them all
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    for (const rule of existingRules) {
        ruleIdsToRemove.push(rule.id);
    }

    for (const [hostname, prefs] of Object.entries(site_prefs)) {
        if (prefs.enabled === false) {
            // Assign deterministic rule ID if it doesn't have one (solves DJB2 Rule Collisions)
            if (!rule_allocator[hostname]) {
                rule_allocator[hostname] = nextRuleId++;
                allocatorChanged = true;
            }
            disabledDomains.push({ hostname: hostname, id: rule_allocator[hostname] });
        }
    }

    if (allocatorChanged) {
        await chrome.storage.local.set({ rule_allocator, nextRuleId });
    }

    const rulesConfig = {
        removeRuleIds: ruleIdsToRemove,
        addRules: []
    };

    for (const site of disabledDomains) {
        rulesConfig.addRules.push({
            id: site.id,
            priority: 2,
            action: { type: "allow" }, // Bypasses the strict rules.json injection
            condition: {
                requestDomains: [site.hostname],
                resourceTypes: ASSET_TYPES
            }
        });
    }

    try {
        await chrome.declarativeNetRequest.updateDynamicRules(rulesConfig);
    } catch (e) {
        console.error("[Assets Cacher] DNR exception error:", e);
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.site_prefs) {
        applySitePreferences();
    }
});

// -- Badge Updates (Debounced via Map) --
function queueBadgeUpdate(tabId, hostname) {
    if (tabId === -1 || !hostname) return;
    memoryTabBadges.set(tabId, hostname);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active && tab.url && tab.url.startsWith('http')) {
        queueBadgeUpdate(tabId, new URL(tab.url).hostname);
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url && tab.url.startsWith('http')) {
            queueBadgeUpdate(activeInfo.tabId, new URL(tab.url).hostname);
        }
    } catch (e) { }
});


// -- Cache hit/miss monitoring (Honest Analytics) --
chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.method !== "GET" || details.statusCode !== 200) return;

        let hostname;
        try { hostname = new URL(details.initiator || details.url).hostname; } catch (e) { return; }

        if (details.fromCache) {
            // Chrome preserves our injected headers in the disk cache
            const forcedHeader = details.responseHeaders?.find(
                h => h.name.toLowerCase() === 'x-assets-cacher-forced'
            );

            if (forcedHeader) {
                let trueSize = memoryAssetSizes.get(details.url);

                if (trueSize === undefined || trueSize === 0) {
                    trueSize = estimateAssetSize(details.url); // Lost to LRU eviction or dashboard reset
                }

                // Update memory aggressively, let the flush daemon handle storage
                pendingGlobalStats.hits++;
                pendingGlobalStats.bytesSaved += trueSize;

                let hostMap = memoryHostStats.get(hostname);
                if (!hostMap) { hostMap = { items: 0, size: 0 }; }
                hostMap.items++;
                hostMap.size += trueSize;
                memoryHostStats.set(hostname, hostMap);

                queueBadgeUpdate(details.tabId, hostname);

                // Refresh LRU position on hit
                storeAssetSize(details.url, trueSize);
            }
        } else {
            // Miss - Check if DNR rule fired
            const forcedHeader = details.responseHeaders?.find(
                h => h.name.toLowerCase() === 'x-assets-cacher-forced'
            );

            if (forcedHeader) {
                let size = 0;
                const clHeader = details.responseHeaders?.find(
                    h => h.name.toLowerCase() === 'content-length'
                );
                if (clHeader && clHeader.value) size = parseInt(clHeader.value, 10);

                // Smart heuristic for Chunked Transfer Encoding (missing Content-Length)
                if (size === 0) {
                    size = estimateAssetSize(details.url);
                }

                storeAssetSize(details.url, size);
                pendingGlobalStats.misses++;
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
);

// -- Messaging --
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true; // Keep channel open for async
});

async function handleMessage(message) {
    if (message.type === 'getState') {
        const { hostname } = message;
        const data = await chrome.storage.local.get(['site_prefs', 'totalSavings', 'stats']);
        const isEnabled = data.site_prefs?.[hostname]?.enabled !== false;
        const localStats = memoryHostStats.get(hostname) || { items: 0, size: 0 };

        return {
            isEnabled,
            itemCount: localStats.items,
            totalSize: localStats.size,
            savings: data.totalSavings || 0,
            stats: data.stats || { hits: 0, misses: 0, bytesSaved: 0 }
        };

    } else if (message.type === 'toggleSite') {
        const { hostname, enabled } = message;
        const data = await chrome.storage.local.get('site_prefs');
        const newPrefs = data.site_prefs || {};
        if (!newPrefs[hostname]) newPrefs[hostname] = {};
        newPrefs[hostname].enabled = enabled;
        await chrome.storage.local.set({ site_prefs: newPrefs });
        return { success: true };

    } else if (message.type === 'getGlobalStats') {
        const { totalSavings, stats } = await chrome.storage.local.get(['totalSavings', 'stats']);

        let sessionItems = 0;
        let sessionSize = 0;
        for (const [host, s] of memoryHostStats) {
            sessionItems += s.items;
            sessionSize += s.size;
        }

        return {
            totalSavings: totalSavings || 0,
            totalItems: sessionItems,
            totalSize: sessionSize,
            stats: stats || { hits: 0, misses: 0, bytesSaved: 0 }
        };

    } else if (message.type === 'purgeSiteCache') {
        memoryHostStats.delete(message.hostname);
        await chrome.storage.session.remove('siteStats'); // Will re-flush on next tick if needed
        return { success: true };

    } else if (message.type === 'purgeAll') {
        memoryHostStats.clear();
        memoryAssetSizes.clear();
        await chrome.storage.session.remove('siteStats');
        await chrome.storage.local.remove('assetSizes');
        await chrome.storage.local.set({
            totalSavings: 0,
            stats: { hits: 0, misses: 0, bytesSaved: 0 }
        });
        return { success: true };

    } else if (message.type === 'resetStats') {
        await chrome.storage.local.set({ stats: { hits: 0, misses: 0, bytesSaved: 0 } });
        return { success: true };
    }

    return { error: 'Unknown message type' };
}