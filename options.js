import { getAllAssets } from './db.js';

const globalSavingsEl = document.getElementById('global-savings');
const globalItemsEl = document.getElementById('global-items');
const globalSizeEl = document.getElementById('global-size');
const cacheTableBodyEl = document.getElementById('cache-table').querySelector('tbody');
const cacheGridEl = document.getElementById('cache-grid');
const purgeAllButton = document.getElementById('purge-all-button');
const settingsForm = document.getElementById('settings-form');
const maxAgeSelect = document.getElementById('max-age');
const filterTabs = document.querySelectorAll('.filter-tab');
const previewModal = document.getElementById('preview-modal');
const previewImage = document.getElementById('preview-image');
const previewUrl = document.getElementById('preview-url');
const previewSize = document.getElementById('preview-size');
const modalClose = previewModal.querySelector('.close');

let allAssets = [];
let currentFilter = 'all';
const objectUrls = new Map();

function formatBytes(bytes) {
    if (bytes === 0) return '0 KB';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getAssetType(contentType, url) {
    if (!contentType) {
        // Fallback to extension
        const ext = url.split('.').pop().split('?')[0].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return 'image';
        if (['js', 'mjs'].includes(ext)) return 'script';
        if (['css'].includes(ext)) return 'style';
        if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
        return 'other';
    }

    if (contentType.startsWith('image/')) return 'image';
    if (contentType.includes('javascript')) return 'script';
    if (contentType.includes('css')) return 'style';
    if (contentType.includes('font') || contentType.includes('woff')) return 'font';
    return 'other';
}

function getFileIcon(type) {
    switch (type) {
        case 'script': return '📜';
        case 'style': return '🎨';
        case 'font': return '🔤';
        default: return '📄';
    }
}

function getFileExt(url) {
    const ext = url.split('.').pop().split('?')[0].toUpperCase();
    return ext.length <= 5 ? ext : 'FILE';
}

function getObjectUrl(asset) {
    if (!asset.blob) return null;
    if (objectUrls.has(asset.url)) return objectUrls.get(asset.url);
    const url = URL.createObjectURL(asset.blob);
    objectUrls.set(asset.url, url);
    return url;
}

async function renderCacheGrid() {
    const filteredAssets = currentFilter === 'all'
        ? allAssets
        : allAssets.filter(a => getAssetType(a.contentType, a.url) === currentFilter);

    if (filteredAssets.length === 0) {
        cacheGridEl.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <div class="icon">📦</div>
                <p>No ${currentFilter === 'all' ? '' : currentFilter + ' '}assets cached yet.</p>
            </div>
        `;
        return;
    }

    cacheGridEl.innerHTML = '';

    for (const asset of filteredAssets) {
        const type = getAssetType(asset.contentType, asset.url);
        const item = document.createElement('div');
        item.className = `cache-item ${type !== 'image' ? 'non-image' : ''}`;
        item.dataset.url = asset.url;
        item.dataset.size = asset.size;

        if (type === 'image') {
            const url = getObjectUrl(asset);
            if (url) {
                item.innerHTML = `
                    <img src="${url}" alt="Cached image" loading="lazy">
                    <div class="overlay">
                        <span class="size">${formatBytes(asset.size)}</span>
                    </div>
                `;
            } else {
                item.className = 'cache-item non-image';
                item.innerHTML = `
                    <span class="file-icon">🖼️</span>
                    <span class="file-ext">${getFileExt(asset.url)}</span>
                `;
            }
        } else {
            item.innerHTML = `
                <span class="file-icon">${getFileIcon(type)}</span>
                <span class="file-ext">${getFileExt(asset.url)}</span>
            `;
        }

        item.addEventListener('click', () => openPreview(asset));
        cacheGridEl.appendChild(item);
    }
}

function openPreview(asset) {
    const type = getAssetType(asset.contentType, asset.url);

    if (type === 'image') {
        const url = getObjectUrl(asset);
        if (url) {
            previewImage.src = url;
            previewUrl.textContent = asset.url;
            previewSize.textContent = `${formatBytes(asset.size)} • Cached ${new Date(asset.cachedOn).toLocaleString()}`;
            previewModal.classList.add('active');
        }
    } else {
        // For non-images, just show URL info
        previewImage.src = '';
        previewUrl.textContent = asset.url;
        previewSize.textContent = `${formatBytes(asset.size)} • ${getFileExt(asset.url)} • Cached ${new Date(asset.cachedOn).toLocaleString()}`;
        previewModal.classList.add('active');
    }
}

modalClose.addEventListener('click', () => {
    previewModal.classList.remove('active');
});

previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) {
        previewModal.classList.remove('active');
    }
});

// Filter tabs
filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        filterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.dataset.filter;
        renderCacheGrid();
    });
});

async function populateData() {
    // Populate stats from background
    const stats = await chrome.runtime.sendMessage({ type: 'getGlobalStats' });
    if (stats) {
        globalSavingsEl.textContent = formatBytes(stats.totalSavings);
        globalItemsEl.textContent = stats.totalItems;
        globalSizeEl.textContent = formatBytes(stats.totalSize);
    }

    // Load assets directly from IndexedDB instead of messaging!
    try {
        allAssets = await getAllAssets();
    } catch (e) {
        console.error("Failed to load assets from DB:", e);
        allAssets = [];
    }

    // Render grid
    renderCacheGrid();

    // Populate table
    if (allAssets.length > 0) {
        cacheTableBodyEl.innerHTML = '';
        allAssets.sort((a, b) => b.lastAccessed - a.lastAccessed).forEach(asset => {
            const type = getAssetType(asset.contentType, asset.url);
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${asset.url}</td>
                <td><span style="text-transform: capitalize">${type}</span></td>
                <td>${formatBytes(asset.size)}</td>
                <td>${new Date(asset.cachedOn).toLocaleString()}</td>
                <td>${new Date(asset.lastAccessed).toLocaleString()}</td>
            `;
            cacheTableBodyEl.appendChild(row);
        });
    } else {
        cacheTableBodyEl.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #6b778c;">No cached assets yet.</td></tr>';
    }

    // Populate settings
    const settings = await chrome.storage.local.get('settings');
    if (settings.settings?.maxAge) {
        maxAgeSelect.value = settings.settings.maxAge;
    }
}

purgeAllButton.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete all cached data? This cannot be undone.')) {
        chrome.runtime.sendMessage({ type: 'purgeAll' }, () => {
            alert('All cache has been cleared.');
            location.reload();
        });
    }
});

settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const newSettings = {
        maxAge: parseInt(maxAgeSelect.value, 10)
    };
    chrome.storage.local.set({ settings: newSettings });
    alert('Settings saved!');
});

document.addEventListener('DOMContentLoaded', populateData);