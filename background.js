// --- Background: Cache hit/miss monitoring ---

let siteStats = {};

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

// -- Per-site exceptions via dynamic DNR rules --
const ASSET_TYPES = ["stylesheet", "script", "image", "font", "media", "object"];

async function applySitePreferences() {
    const { site_prefs } = await chrome.storage.local.get('site_prefs');
    if (!site_prefs) return;

    const disabledDomains = [];
    for (const [hostname, data] of Object.entries(site_prefs)) {
        if (data.enabled === false) disabledDomains.push(hostname);
    }

    const rulesConfig = {
        removeRuleIds: [2],
        addRules: []
    };

    if (disabledDomains.length > 0) {
        rulesConfig.addRules.push({
            id: 2,
            priority: 2,
            action: { type: "allow" },
            condition: {
                requestDomains: disabledDomains,
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

// -- Badge --
function updateActionBadge(tabId, hostname) {
    if (!hostname) return;
    try {
        const count = siteStats[hostname] ? siteStats[hostname].items : 0;
        chrome.action.setBadgeText({ tabId, text: count > 0 ? count.toString() : '' });
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

// -- Cache hit/miss monitoring --
chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.method !== "GET" || details.statusCode !== 200) return;

        let hostname;
        try {
            hostname = new URL(details.initiator || details.url).hostname;
        } catch (e) { return; }

        if (!siteStats[hostname]) {
            siteStats[hostname] = { items: 0, size: 0 };
        }

        if (details.fromCache) {
            let size = 0;
            const clHeader = details.responseHeaders?.find(
                h => h.name.toLowerCase() === 'content-length'
            );
            if (clHeader && clHeader.value) size = parseInt(clHeader.value, 10);

            queueStatUpdate('hit', size);
            siteStats[hostname].items++;
            siteStats[hostname].size += size;

            if (details.tabId !== -1) updateActionBadge(details.tabId, hostname);
        } else {
            queueStatUpdate('miss', 0);
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
        const localStats = siteStats[hostname] || { items: 0, size: 0 };

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
        let sessionItems = 0;
        let sessionSize = 0;
        for (const host in siteStats) {
            sessionItems += siteStats[host].items;
            sessionSize += siteStats[host].size;
        }
        return {
            totalSavings: totalSavings || 0,
            totalItems: sessionItems,
            totalSize: sessionSize,
            stats: stats || { hits: 0, misses: 0, bytesSaved: 0 }
        };

    } else if (message.type === 'purgeSiteCache') {
        delete siteStats[message.hostname];
        return { success: true };

    } else if (message.type === 'purgeAll') {
        siteStats = {};
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