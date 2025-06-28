# 🧠 Assets Cacher

> A lightweight Chrome extension to reduce bandwidth usage by caching frequently downloaded assets like images, scripts, and fonts, with per-site controls.

---

## 🤔 What's the Big Idea?

Do you visit websites that are heavy on images or use the same JavaScript libraries on every page? Every time you navigate, your browser might be re-downloading these same assets, consuming your bandwidth and slowing down page loads.

**Assets Cacher** intercepts these requests. The first time an asset is downloaded, the extension saves a copy. On all subsequent requests for that *exact same asset*, it serves the saved copy directly from your local machine, resulting in near-instantaneous loads and saving you data.

## ✨ Key Features

-   **Selective Caching**: Intelligently caches common asset types like images (`jpg`, `png`, `webp`), scripts (`js`), stylesheets (`css`), and fonts.
-   **Per-Site Control**: Easily enable or disable caching for any website with a single click in the extension popup.
-   **Stale Cache Validation**: Uses `ETag` and `Last-Modified` headers to automatically check if an asset has been updated on the server. If it has, the new version is fetched and re-cached.
-   **Cache Management**:
    -   View the number of cached items and the total size of the cache for the current site.
    -   Manually purge the entire cache for a specific site with one button.
-   **Bandwidth Savings**: Drastically reduces data consumption on asset-heavy websites you frequent.
-   **Built for Manifest V3**: Uses the modern, secure Chrome Extension platform.

## 🚀 Installation

Since this extension is not on the Chrome Web Store, you can install it locally by following these steps:

1.  **Download the Code**:
    -   Clone this repository to your local machine:
        ```bash
        git clone https://github.com/your-username/smart-asset-cache.git
        ```
    -   Or, click the "Code" button on GitHub and select **"Download ZIP"**, then unzip the file.

2.  **Open Chrome Extensions**:
    -   Open your Google Chrome browser.
    -   Navigate to `chrome://extensions` in the address bar.

3.  **Enable Developer Mode**:
    -   In the top-right corner of the Extensions page, toggle on the **"Developer mode"** switch.

4.  **Load the Extension**:
    -   Click the **"Load unpacked"** button that appears.
    -   In the file selection dialog, navigate to and select the `smart-asset-cache` folder (the one that contains `manifest.json`).
    -   Click "Select Folder".

The extension is now installed! You should see the "Assets Cacher" icon (you may need to pin it) in your Chrome toolbar.

## 🛠️ How to Use

1.  **Navigate** to any website.
2.  **Click** on the Assets Cacher icon in your toolbar to open the popup.
3.  **Enable Caching**: The popup will show the current site's hostname. Use the toggle switch to enable caching for this site.
4.  **Browse**: As you browse the site, the extension will automatically start caching eligible assets in the background. Reload a page to see the effect—assets will be served from the cache on the second load.
5.  **Check Status**: Click the icon again at any time to see how many items have been cached and the total disk space saved.
6.  **Purge Cache**: If you're experiencing issues or want to clear the stored data for the site, simply click the **"Purge Cache for this Site"** button.

## ⚙️ How It Works (The Technical Details)

This extension uses a two-step process aligned with Manifest V3's non-blocking API requirements:

1.  **Redirection (`onBeforeRequest`)**: This listener fires *before* a network request is made. It performs a very fast check against the in-memory cache. If a fresh, valid asset exists, it uses the `chrome.declarativeNetRequest` API to create a dynamic rule that redirects the request to a local `blob:` URL, skipping the network entirely.

2.  **Caching & Validation (`onCompleted`)**: This listener fires *after* a network request has finished.
    -   It checks the response's `Content-Type` header to see if the asset is cacheable.
    -   It compares the response's `ETag` and `Last-Modified` headers against any existing cached version.
    -   If the asset is new or has been updated (stale cache), it fetches the full content in the background, creates a `blob:`, and stores it in the cache for future requests.

This separation ensures that the performance-critical redirection path is as fast as possible, while the heavier work of caching happens asynchronously.

## 📜 License

This project is licensed under the GPL-3.0 License.