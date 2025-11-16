# Assets Cacher
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
- A lightweight Chrome extension to reduce bandwidth usage by caching frequently downloaded assets like images, scripts, and fonts, with per-site controls.

---

## What's the Big Idea?
Do you visit websites that are heavy on images or use the same JavaScript libraries on every page? Every time you navigate, your browser might be re-downloading these same assets, consuming your bandwidth and slowing down page loads.

**Assets Cacher** intercepts these requests. The first time an asset is downloaded, the extension saves a copy. On all subsequent requests for that *exact same asset*, it serves the saved copy directly from your local machine, resulting in near-instantaneous loads and saving you data.

## Key Features
-   **Aggressive Caching:** Intelligently caches static assets like images, JS, CSS, and fonts to reduce redundant downloads.
-   **Bandwidth Savings Tracker:** See a running total of the data you've saved in the popup and options page.
-   **Per-Site Control:** Caching is enabled by default. You can easily disable it for any specific website with a single click.
-   **Advanced Cache Management (Options Page):**
    -   View global statistics (total items cached, total size, total bandwidth saved).
    -   See a detailed table of every single cached asset, including its size and cache date.
    -   Set a global cache eviction policy (e.g., automatically delete assets older than 30 days).
    -   Purge the entire cache for all sites with one click.
-   **Smart Validation:** Respects `ETag` and `Last-Modified` headers to automatically fetch fresh assets when they are updated on the server.
-   **Built for Manifest V3:** Uses a modern, secure, and persistent architecture with IndexedDB for storage.

## Installation
Since this extension is not on the Chrome Web Store, you can install it locally by following these steps:

1.  **Download the Code**:
    -   Clone this repository to your local machine:
        ```bash
        git clone https://github.com/Akhil-Chaturvedi/Assets-Cacher.git
        ```
    -   Or, click the "Code" button on GitHub and select **"Download ZIP"**, then unzip the file.

2.  **Open Chrome Extensions**:
    -   Open your Google Chrome browser.
    -   Navigate to `chrome://extensions` in the address bar.

3.  **Enable Developer Mode**:
    -   In the top-right corner of the Extensions page, toggle on the **"Developer mode"** switch.

4.  **Load the Extension**:
    -   Click the **"Load unpacked"** button that appears.
    -   In the file selection dialog, navigate to and select the `Assets-Cacher` folder (the one that contains `manifest.json`).
    -   Click "Select Folder".

The extension is now installed! You should see the "Assets Cacher" icon (you may need to pin it) in your Chrome toolbar.

## How to Use
1.  **Navigate** to any website. Caching is enabled by default and will start working in the background.
2.  **Check the Badge**: The extension icon will show a green badge with the number of assets cached for the current site.
3.  **View Stats**: Click the Assets Cacher icon to open the popup and see stats for the current site, including bandwidth saved.
4.  **Disable Caching**: If a site isn't working correctly, simply use the toggle in the popup to disable caching for that domain.
5.  **Manage Everything**: Click the "Options" link in the popup to access the global cache manager, see all cached files, and purge data.

## How It Works (The Technical Details)
This extension uses a persistent, service-worker-compatible architecture to cache assets.

1.  **Fetch and Convert (`onCompleted`)**: After a network request for a cacheable asset (like an image or script) finishes, the extension fetches it in the background. It then converts the asset's binary data into a `data:` URL (a Base64 encoded string).

2.  **Store in IndexedDB**: This `data:` URL, along with metadata like the ETag, size, and the original website's domain (`initiator`), is stored in the browser's IndexedDB. This provides a large, persistent storage solution that works perfectly within a Manifest V3 service worker.

3.  **Intercept and Redirect (`onBeforeRequest`)**: Before any subsequent request is made, the extension checks its in-memory cache (loaded from IndexedDB). If a valid, fresh entry exists, it uses the `chrome.declarativeNetRequest` API to create a dynamic rule. This rule instantly redirects the browser's request to the stored `data:` URL, completely avoiding the network and serving the asset in microseconds.

This model is robust, fully persistent across browser sessions, and respects the technical constraints of the modern Manifest V3 platform.

## License
This project is licensed under the **GNU General Public License v3.0**.