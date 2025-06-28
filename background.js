import { getAsset, addAsset, getAllAssets, clearDB, deleteAsset } from './db.js';

// --- Configuration & State ---
const CACHE_RULE_ID = 1;
const ALLOWED_CONTENT_TYPES = [
  "image/", "font/", "text/css", "application/javascript", "application/x-javascript"
];
const tabCacheHits = {}; 

// --- Helper Functions ---
const isCacheable = (contentType) => contentType && ALLOWED_CONTENT_TYPES.some(type => contentType.startsWith(type));
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// --- Badge Management & Startup ---
chrome.runtime.onStartup.addListener(() => {
    chrome.action.setBadgeBackgroundColor({ color: '#28a745' });
});
chrome.action.setBadgeBackgroundColor({ color: '#28a745' });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabCacheHits[tabId] = 0;
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

// --- Eviction Alarm ---
chrome.alarms.create('evictionAlarm', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(runEviction);

// --- Caching Logic ---
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.method !== "GET" || !details.initiator) return;
    const hostname = new URL(details.initiator).hostname;
    
    const prefs = await chrome.storage.local.get('site_prefs');
    if (prefs.site_prefs?.[hostname]?.enabled === false) {
      clearRedirectRules();
      return;
    }

    const cachedAsset = await getAsset(details.url); 
    if (cachedAsset) {
      updateRedirectRule(details.url, cachedAsset.dataUrl);

      // 1. Update PERSISTENT savings tracker
      const { site_savings } = await chrome.storage.local.get('site_savings');
      const newSavings = site_savings || {};
      newSavings[hostname] = (newSavings[hostname] || 0) + cachedAsset.size;
      await chrome.storage.local.set({ site_savings: newSavings });
      
      if (details.tabId >= 0) {
          tabCacheHits[details.tabId] = (tabCacheHits[details.tabId] || 0) + 1;
          chrome.action.setBadgeText({
            tabId: details.tabId,
            text: tabCacheHits[details.tabId].toString()
          });
      }

    } else {
      clearRedirectRules();
    }
  },
  { urls: ["<all_urls>"], types: ["image", "font", "stylesheet", "script"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.method !== "GET" || details.statusCode !== 200 || !details.initiator) return;
    const contentTypeHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
    if (isCacheable(contentTypeHeader?.value)) {
      validateAndCacheAsset(details);
    }
  },
  { urls: ["<all_urls>"], types: ["image", "font", "stylesheet", "script"] },
  ["responseHeaders"]
);

async function validateAndCacheAsset(details) {
  const { url, initiator, responseHeaders } = details;
  const hostname = new URL(initiator).hostname;
  const prefs = await chrome.storage.local.get('site_prefs');
  if (prefs.site_prefs?.[hostname]?.enabled === false) return;

  const etag = responseHeaders.find(h => h.name.toLowerCase() === 'etag')?.value || '';
  const lastModified = responseHeaders.find(h => h.name.toLowerCase() === 'last-modified')?.value || '';
  const existingAsset = await getAsset(url);

  if (existingAsset) {
    if ((existingAsset.etag && existingAsset.etag === etag) || (existingAsset.lastModified && existingAsset.lastModified === lastModified)) return;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const blob = await response.blob();
    const dataUrl = await blobToDataURL(blob);
    await addAsset({ url, hostname, dataUrl, size: blob.size, etag, lastModified, cachedOn: Date.now(), lastAccessed: Date.now() });
  } catch (e) {
    console.error(`[Smart Cache] Failed to cache asset ${url}:`, e);
  }
}

// --- Eviction, Rule, and Purge Functions ---
async function runEviction() {
    const { settings } = await chrome.storage.local.get('settings');
    const maxAgeDays = settings?.maxAge || 0;
    if (maxAgeDays === 0) return;
    const allAssets = await getAllAssets();
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    for (const asset of allAssets) {
        if (now - asset.cachedOn > maxAgeMs) await deleteAsset(asset.url);
    }
}

function updateRedirectRule(requestUrl, redirectUrl) {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CACHE_RULE_ID],
    addRules: [{ id: CACHE_RULE_ID, priority: 1, action: { type: 'redirect', redirect: { url: redirectUrl } }, condition: { urlFilter: requestUrl, resourceTypes: ["image", "font", "stylesheet", "script"] } }]
  });
}
function clearRedirectRules() {
  chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [CACHE_RULE_ID] });
}

async function purgeSiteCache(hostname) {
    const allAssets = await getAllAssets();
    for (const asset of allAssets) {
        if (asset.hostname === hostname) await deleteAsset(asset.url);
    }
    const { site_savings } = await chrome.storage.local.get('site_savings');
    if (site_savings) {
        delete site_savings[hostname];
        await chrome.storage.local.set({ site_savings });
    }
    clearRedirectRules();
}

// --- Message Handler ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        switch (message.type) {
            case 'getState': {
                const allAssets = await getAllAssets();
                const siteAssets = allAssets.filter(a => a.hostname === message.hostname);
                const { site_savings } = await chrome.storage.local.get('site_savings');
                const siteStats = {
                    itemCount: siteAssets.length,
                    totalSize: siteAssets.reduce((sum, a) => sum + a.size, 0),
                    savings: site_savings?.[message.hostname] || 0
                };
                const prefs = await chrome.storage.local.get('site_prefs');
                const isEnabled = !(prefs.site_prefs?.[message.hostname]?.enabled === false);
                sendResponse({ isEnabled, ...siteStats });
                break;
            }
            case 'toggleSite': {
                const prefs = await chrome.storage.local.get('site_prefs');
                const sitePrefs = prefs.site_prefs || {};
                if (!sitePrefs[message.hostname]) sitePrefs[message.hostname] = {};
                sitePrefs[message.hostname].enabled = message.enabled;
                await chrome.storage.local.set({ site_prefs: sitePrefs });
                if (!message.enabled) await purgeSiteCache(message.hostname);
                sendResponse({ success: true });
                break;
            }
            case 'purgeSiteCache': {
                await purgeSiteCache(message.hostname);
                sendResponse({ success: true });
                break;
            }
            case 'getGlobalStats': {
                const allAssets = await getAllAssets();
                const { site_savings } = await chrome.storage.local.get('site_savings');
                let totalSavings = 0;
                if(site_savings) {
                    totalSavings = Object.values(site_savings).reduce((sum, s) => sum + s, 0);
                }
                const globalStats = {
                    totalItems: allAssets.length,
                    totalSize: allAssets.reduce((sum, a) => sum + a.size, 0),
                    totalSavings: totalSavings
                };
                sendResponse(globalStats);
                break;
            }
            case 'getAllAssets': {
                sendResponse(await getAllAssets());
                break;
            }
            case 'purgeAll': {
                await clearDB();
                await chrome.storage.local.remove('site_savings');
                sendResponse({ success: true });
                break;
            }
        }
    })();
    return true;
});