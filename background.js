// --- Data Structure ---
// In-memory cache for fast access during a session. The ground truth is in IndexedDB.
let siteCache = {};

// --- Configuration ---
const CACHE_RULE_ID = 1;
const DB_NAME = "AssetCacheDB";
const DB_VERSION = 1;
const STORE_NAME = "assets";
const DISALLOWED_CONTENT_TYPES = [
  "text/html", "application/json", "application/xml", "text/xml", "application/octet-stream"
];

// --- IndexedDB Helpers ---
let db;

async function openDB() {
    return new Promise((resolve, reject) => {
        if (db) return resolve(db);
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => reject("IndexedDB error: " + request.error);
        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            db.createObjectStore(STORE_NAME, { keyPath: "url" });
        };
    });
}

async function getAssetFromDB(url) {
    const db = await openDB();
    return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(url);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null); // Resolve null on error
    });
}

async function setAssetInDB(asset) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(asset);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function deleteAssetFromDB(url) {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(url);
}

async function clearDB() {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
}

async function loadCacheFromDB() {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const allAssets = await new Promise(resolve => store.getAll().onsuccess = e => resolve(e.target.result));
    
    siteCache = {};
    for (const asset of allAssets) {
        const hostname = new URL(asset.url).hostname;
        if (!siteCache[hostname]) {
            siteCache[hostname] = { totalSize: 0, assets: {} };
        }
        siteCache[hostname].assets[asset.url] = asset;
        siteCache[hostname].totalSize += asset.size;
    }
    console.log(`[Smart Cache] Loaded ${allAssets.length} assets from IndexedDB into memory.`);
}


// --- Initialization & Alarms ---
chrome.runtime.onStartup.addListener(loadCacheFromDB);
chrome.runtime.onInstalled.addListener(() => {
    loadCacheFromDB();
    chrome.alarms.create('cacheEviction', { periodInMinutes: 60 });
    chrome.action.setBadgeBackgroundColor({ color: '#28a745' });
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'cacheEviction') evictOldCache(); });


// --- Badge Logic --- (No changes needed here)
async function updateActionBadge(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.url && tab.url.startsWith('http')) {
            const hostname = new URL(tab.url).hostname;
            const count = siteCache[hostname] ? Object.keys(siteCache[hostname].assets).length : 0;
            chrome.action.setBadgeText({ tabId, text: count > 0 ? count.toString() : '' });
        } else {
            chrome.action.setBadgeText({ tabId, text: '' });
        }
    } catch (e) { /* Tab may be closed */ }
}
chrome.tabs.onActivated.addListener((activeInfo) => updateActionBadge(activeInfo.tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (changeInfo.status === 'complete' && tab.active) updateActionBadge(tabId); });


// --- Caching Logic ---
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.method !== "GET") return;
    const initiator = details.initiator;
    if (!initiator) return;
    const hostname = new URL(initiator).hostname;
    const cachedAsset = siteCache[hostname]?.assets?.[details.url];
    
    if (cachedAsset && cachedAsset.dataUrl) { 
      updateRedirectRule(details.url, cachedAsset.dataUrl);
      cachedAsset.lastAccessed = Date.now();
      await setAssetInDB(cachedAsset); // Update lastAccessed in DB
      const { totalSavings } = await chrome.storage.local.get('totalSavings');
      await chrome.storage.local.set({ totalSavings: (totalSavings || 0) + cachedAsset.size });
    } else {
      clearRedirectRules();
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.method !== "GET" || details.statusCode !== 200) return;
    const contentTypeHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
    const contentType = contentTypeHeader?.value || '';
    if (!DISALLOWED_CONTENT_TYPES.some(type => contentType.startsWith(type))) {
        validateAndCacheAsset(details);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function validateAndCacheAsset(details) {
  const { url, initiator, tabId } = details;
  if (!initiator) return;
  const hostname = new URL(initiator).hostname;
  const { site_prefs } = await chrome.storage.local.get('site_prefs');
  if ((site_prefs || {})[hostname]?.enabled === false) return;

  const etag = details.responseHeaders.find(h => h.name.toLowerCase() === 'etag')?.value || '';
  const lastModified = details.responseHeaders.find(h => h.name.toLowerCase() === 'last-modified')?.value || '';
  const existingAsset = siteCache[hostname]?.assets?.[url];

  if (existingAsset && ((existingAsset.etag && existingAsset.etag === etag) || (existingAsset.lastModified && existingAsset.lastModified === lastModified))) {
    return;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const blob = await response.blob();
    const sizeInBytes = blob.size;
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB limit per file
    if (sizeInBytes > MAX_FILE_SIZE) return;

    const dataUrl = await blobToDataURL(blob);
    const newAsset = {
        url, dataUrl, size: blob.size, etag, lastModified,
        cachedOn: Date.now(), lastAccessed: Date.now()
    };
    
    await setAssetInDB(newAsset);

    if (!siteCache[hostname]) siteCache[hostname] = { totalSize: 0, assets: {} };
    if (existingAsset) siteCache[hostname].totalSize -= existingAsset.size;
    siteCache[hostname].assets[url] = newAsset;
    siteCache[hostname].totalSize += newAsset.size;

    if (tabId !== -1) updateActionBadge(tabId);
  } catch (e) {
    console.error(`[Smart Cache] Failed to process ${url}:`, e);
  }
}

// --- Rule Management ---
function updateRedirectRule(requestUrl, redirectUrl) {
    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [CACHE_RULE_ID],
        addRules: [{ id: CACHE_RULE_ID, priority: 1, action: { type: 'redirect', redirect: { url: redirectUrl } }, condition: { urlFilter: requestUrl } }]
    });
}
function clearRedirectRules() {
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [CACHE_RULE_ID] });
}

// --- Communication --- (No changes needed here)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        if (message.type === 'getState') {
            const { hostname } = message;
            const data = await chrome.storage.local.get(['site_prefs', 'totalSavings']);
            const sitePrefs = data.site_prefs || {};
            const isEnabled = sitePrefs[hostname]?.enabled !== false;
            const cacheData = siteCache[hostname];
            sendResponse({
                isEnabled,
                itemCount: cacheData ? Object.keys(cacheData.assets).length : 0,
                totalSize: cacheData ? cacheData.totalSize : 0,
                savings: data.totalSavings || 0
            });
        } else if (message.type === 'toggleSite') {
            const { hostname, enabled } = message;
            const { site_prefs } = await chrome.storage.local.get('site_prefs');
            const newPrefs = site_prefs || {};
            if (!newPrefs[hostname]) newPrefs[hostname] = {};
            newPrefs[hostname].enabled = enabled;
            await chrome.storage.local.set({ site_prefs: newPrefs });
            if (!enabled) await purgeSiteCache(hostname);
        } else if (message.type === 'purgeSiteCache') {
            await purgeSiteCache(message.hostname);
            sendResponse({ success: true });
        } else if (message.type === 'getGlobalStats') {
            const { totalSavings } = await chrome.storage.local.get('totalSavings');
            let totalItems = 0; let totalSize = 0;
            for (const host in siteCache) {
                totalItems += Object.keys(siteCache[host].assets).length;
                totalSize += siteCache[host].totalSize;
            }
            sendResponse({ totalSavings: totalSavings || 0, totalItems, totalSize });
        } else if (message.type === 'getAllAssets') {
            const allAssets = [];
            for (const host in siteCache) {
                for (const url in siteCache[host].assets) {
                    const { dataUrl, ...rest } = siteCache[host].assets[url];
                    allAssets.push({ url, ...rest });
                }
            }
            sendResponse(allAssets);
        } else if (message.type === 'purgeAll') {
            await purgeAllCache();
            sendResponse({ success: true });
        }
    })();
    return true;
});

// --- Cache Management Functions ---
async function purgeSiteCache(hostname) {
    if (siteCache[hostname]) {
        for (const url in siteCache[hostname].assets) {
            await deleteAssetFromDB(url);
        }
        clearRedirectRules();
        delete siteCache[hostname];
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) updateActionBadge(tabs[0].id);
    }
}
async function purgeAllCache() {
    await clearDB();
    clearRedirectRules();
    siteCache = {};
    await chrome.storage.local.set({ totalSavings: 0 });
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
    const allAssets = [];
    for (const host in siteCache) {
        for (const url in siteCache[host].assets) {
            allAssets.push(siteCache[host].assets[url]);
        }
    }
    for (const asset of allAssets) {
        if (now - asset.cachedOn > maxAgeMs) {
            await deleteAssetFromDB(asset.url);
            itemsEvicted++;
        }
    }
    if (itemsEvicted > 0) {
        await loadCacheFromDB(); // Reload from DB to update memory
        console.log(`[Smart Cache] Evicted ${itemsEvicted} old items from cache.`);
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) updateActionBadge(tabs[0].id);
    }
}