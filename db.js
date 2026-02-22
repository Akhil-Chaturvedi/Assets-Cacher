// --- IndexedDB Module for Assets Cacher ---
const DB_NAME = "AssetCacheDB";
const DB_VERSION = 3; // Bumped to 3 to recreate store for Blob objects
const STORE_NAME = "assets";

let db = null;
let dbPromise = null;

/**
 * Opens the IndexedDB database, creating it if necessary.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  // Return existing database if already connected
  if (db) {
    return Promise.resolve(db);
  }

  // Return pending promise if already opening
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    console.log("[DB] Opening IndexedDB...");

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error("[DB] Error opening database:", request.error);
      dbPromise = null;
      reject("IndexedDB error: " + request.error);
    };

    request.onsuccess = (event) => {
      console.log("[DB] Database opened successfully");
      db = event.target.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      console.log("[DB] Upgrading database schema from version", event.oldVersion, "to", event.newVersion);
      const database = event.target.result;
      const transaction = event.target.transaction;

      // Create object store if it doesn't exist
      let store;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        store = database.createObjectStore(STORE_NAME, { keyPath: "url" });
        console.log("[DB] Created object store:", STORE_NAME);
      } else {
        store = transaction.objectStore(STORE_NAME);
      }

      // Create indexes if they don't exist
      if (!store.indexNames.contains("initiator")) {
        store.createIndex("initiator", "initiator", { unique: false });
        console.log("[DB] Created initiator index");
      }
      if (!store.indexNames.contains("lastAccessed")) {
        store.createIndex("lastAccessed", "lastAccessed", { unique: false });
        console.log("[DB] Created lastAccessed index");
      }
    };

    request.onblocked = (event) => {
      console.warn("[DB] Database blocked - close other tabs using this extension");
    };
  });

  return dbPromise;
}

/**
 * Stores or updates an asset in the database.
 * @param {Object} asset - The asset object to store
 * @returns {Promise<void>}
 */
export async function setAsset(asset) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(asset);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    } catch (e) {
      console.error("[DB] setAsset error:", e);
      reject(e);
    }
  });
}

/**
 * Retrieves an asset by URL.
 * @param {string} url - The URL of the asset
 * @returns {Promise<Object|undefined>}
 */
export async function getAsset(url) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(url);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } catch (e) {
      console.error("[DB] getAsset error:", e);
      reject(e);
    }
  });
}

/**
 * Retrieves all assets from the database.
 * @returns {Promise<Object[]>}
 */
export async function getAllAssets() {
  console.log("[DB] getAllAssets called");
  const database = await openDB();
  console.log("[DB] Got database, fetching assets...");
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        console.log("[DB] getAllAssets success:", request.result?.length || 0, "assets");
        resolve(request.result || []);
      };
      request.onerror = () => {
        console.error("[DB] getAllAssets error:", request.error);
        reject(request.error);
      };
    } catch (e) {
      console.error("[DB] getAllAssets exception:", e);
      reject(e);
    }
  });
}

/**
 * Deletes an asset by URL.
 * @param {string} url - The URL of the asset to delete
 * @returns {Promise<void>}
 */
export async function deleteAsset(url) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(url);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    } catch (e) {
      console.error("[DB] deleteAsset error:", e);
      reject(e);
    }
  });
}

/**
 * Clears all assets from the database.
 * @returns {Promise<void>}
 */
export async function clearAllAssets() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => {
        console.log("[DB] All assets cleared");
        resolve();
      };
      request.onerror = () => reject(request.error);
    } catch (e) {
      console.error("[DB] clearAllAssets error:", e);
      reject(e);
    }
  });
}

/**
 * Retrieves all assets for a specific hostname (initiator).
 * Uses the initiator index for efficient lookup.
 * @param {string} hostname - The hostname to get assets for
 * @returns {Promise<Object[]>}
 */
export async function getAssetsByInitiator(hostname) {
  console.log("[DB] getAssetsByInitiator called for:", hostname);
  const database = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("initiator");
      const request = index.getAll(hostname);
      request.onsuccess = () => {
        console.log("[DB] Got", request.result?.length || 0, "assets for", hostname);
        resolve(request.result || []);
      };
      request.onerror = () => {
        console.error("[DB] getAssetsByInitiator error:", request.error);
        reject(request.error);
      };
    } catch (e) {
      console.error("[DB] getAssetsByInitiator exception:", e);
      reject(e);
    }
  });
}