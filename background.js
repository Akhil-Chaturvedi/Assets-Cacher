// --- Background: Cache hit/miss monitoring ---

console.log("[Assets Cacher] Monitor starting.");

// -- Stats batching --
let pendingStats = { hits: 0, misses: 0, bytesSaved: 0 };
let statWriteTimer = null;

function queueStatUpdate(type, size = 0) {
    if (type === 'hit') pendingStats.hits++;
    if (type === 'miss') pendingStats.misses++;
    pendingStats.bytesSaved += size;

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
        pendingStats.hits += toSave.hits;
        pendingStats.misses += toSave.misses;
        pendingStats.bytesSaved += toSave.bytesSaved;
        if (!statWriteTimer) statWriteTimer = setTimeout(flushStats, 2000);
    }
}

// -- Initialization --
chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeBackgroundColor({ color: '#2d2d2d' });
    chrome.storage.local.get(['stats'], (data) => {
        if (!data.stats) {
            chrome.storage.local.set({
                stats: { hits: 0, misses: 0, bytesSaved: 0 }
            });
        }
    });
});

// -- Utility: Hash string to int for DNR rules --
function hashStringToInt(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    // Ensure positive integer for DNR rule ID (DNR ids must be >= 1)
    return Math.abs(hash) + 10000;
}

// -- Per-site exceptions via dynamic DNR rules --
const ASSET_TYPES = ["stylesheet", "script", "image", "font", "media", "object"];

async function applySitePreferences() {
    const { site_prefs } = await chrome.storage.local.get('site_prefs');
    if (!site_prefs) return;

    const disabledDomains = [];
    const ruleIdsToRemove = [];

    // Collect all disabled domains and their deterministic hashed IDs
    for (const [hostname, data] of Object.entries(site_prefs)) {
        const ruleId = hashStringToInt(hostname);
        ruleIdsToRemove.push(ruleId); // We always remove to refresh
        if (data.enabled === false) {
            disabledDomains.push({ hostname: hostname, id: ruleId });
        }
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

// -- Session Memory (Survives SW sleep, dies on browser close) --
async function getHostStats(hostname) {
    const data = await chrome.storage.session.get('siteStats');
    const allStats = data.siteStats || {};
    return allStats[hostname] || { items: 0, size: 0 };
}

async function updateHostStats(hostname, size) {
    const data = await chrome.storage.session.get('siteStats');
    const allStats = data.siteStats || {};
    if (!allStats[hostname]) allStats[hostname] = { items: 0, size: 0 };

    allStats[hostname].items++;
    allStats[hostname].size += size;

    await chrome.storage.session.set({ siteStats: allStats });
    return allStats[hostname];
}

// Memory of Exact Asset Sizes (Because fromCache drops Content-Length)
async function getOriginalAssetSize(url) {
    const data = await chrome.storage.session.get('assetSizes');
    return (data.assetSizes || {})[url];
}

async function setOriginalAssetSize(url, size) {
    const data = await chrome.storage.session.get('assetSizes');
    const assetSizes = data.assetSizes || {};
    // Cap memory usage - naive GC if too large
    if (Object.keys(assetSizes).length > 2000) {
        const keys = Object.keys(assetSizes);
        for (let i = 0; i < 500; i++) delete assetSizes[keys[i]];
    }
    assetSizes[url] = size;
    await chrome.storage.session.set({ assetSizes });
}

// -- Badge --
async function updateActionBadge(tabId, hostname) {
    if (!hostname) return;
    try {
        const stats = await getHostStats(hostname);
        chrome.action.setBadgeText({ tabId, text: stats.items > 0 ? stats.items.toString() : '' });
    } catch (e) { }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active && tab.url && tab.url.startsWith('http')) {
        updateActionBadge(tabId, new URL(tab.url).hostname);
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url && tab.url.startsWith('http')) {
            updateActionBadge(activeInfo.tabId, new URL(tab.url).hostname);
        }
    } catch (e) { }
});

// -- Cache hit/miss monitoring (Honest Analytics) --
chrome.webRequest.onCompleted.addListener(
    async (details) => {
        if (details.method !== "GET" || details.statusCode !== 200) return;

        let hostname;
        try { hostname = new URL(details.initiator || details.url).hostname; } catch (e) { return; }

        if (details.fromCache) {
            // Chrome's disk cache preserves headers we injected via DNR!
            const forcedHeader = details.responseHeaders?.find(
                h => h.name.toLowerCase() === 'x-assets-cacher-forced'
            );

            // If the cache hit contains our custom header, we forced it. (Solves Stolen Valor)
            if (forcedHeader) {
                let trueSize = await getOriginalAssetSize(details.url);

                // If undefined, it's from a previous browser session.
                // If 0, it was chunked-transfer-encoded on the miss. 
                // We fallback to 30KB to continue logging the hit natively.
                if (trueSize === undefined || trueSize === 0) {
                    trueSize = 30 * 1024;
                }

                queueStatUpdate('hit', trueSize);
                await updateHostStats(hostname, trueSize);
                if (details.tabId !== -1) updateActionBadge(details.tabId, hostname);
            }
        } else {
            // Miss - Check if OUR extension injected headers on this response
            const forcedHeader = details.responseHeaders?.find(
                h => h.name.toLowerCase() === 'x-assets-cacher-forced'
            );

            if (forcedHeader) {
                // We forced this! Store its precise size so we know how much we save on the next visit.
                let size = 0;
                const clHeader = details.responseHeaders?.find(
                    h => h.name.toLowerCase() === 'content-length'
                );
                if (clHeader && clHeader.value) size = parseInt(clHeader.value, 10);

                await setOriginalAssetSize(details.url, size);
                queueStatUpdate('miss', 0);
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
);

// -- Messaging --
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
});

async function handleMessage(message) {
    if (message.type === 'getState') {
        const { hostname } = message;

        if (statWriteTimer) {
            clearTimeout(statWriteTimer);
            await flushStats();
        }

        const data = await chrome.storage.local.get(['site_prefs', 'totalSavings', 'stats']);
        const isEnabled = data.site_prefs?.[hostname]?.enabled !== false;
        const localStats = await getHostStats(hostname);

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
        if (statWriteTimer) {
            clearTimeout(statWriteTimer);
            await flushStats();
        }
        const { totalSavings, stats } = await chrome.storage.local.get(['totalSavings', 'stats']);

        // Sum up session stats from storage
        const sessionData = await chrome.storage.session.get('siteStats');
        const allStats = sessionData.siteStats || {};

        let sessionItems = 0;
        let sessionSize = 0;
        for (const host in allStats) {
            sessionItems += allStats[host].items;
            sessionSize += allStats[host].size;
        }

        return {
            totalSavings: totalSavings || 0,
            totalItems: sessionItems,
            totalSize: sessionSize,
            stats: stats || { hits: 0, misses: 0, bytesSaved: 0 }
        };

    } else if (message.type === 'purgeSiteCache') {
        // Clear session tracking
        const data = await chrome.storage.session.get('siteStats');
        if (data.siteStats && data.siteStats[message.hostname]) {
            delete data.siteStats[message.hostname];
            await chrome.storage.session.set({ siteStats: data.siteStats });
        }
        return { success: true };

    } else if (message.type === 'purgeAll') {
        await chrome.storage.session.remove(['siteStats', 'assetSizes']);
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