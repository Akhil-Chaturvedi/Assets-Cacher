const globalSavingsEl = document.getElementById('global-savings');
const globalItemsEl = document.getElementById('global-items');
const globalSizeEl = document.getElementById('global-size');
const cacheTableBodyEl = document.getElementById('cache-table').querySelector('tbody');
const purgeAllButton = document.getElementById('purge-all-button');
const settingsForm = document.getElementById('settings-form');
const maxAgeSelect = document.getElementById('max-age');

function formatBytes(bytes) {
    if (bytes === 0) return '0 KB';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function populateData() {
    // Populate stats
    const stats = await chrome.runtime.sendMessage({ type: 'getGlobalStats' });
    if (stats) {
        globalSavingsEl.textContent = formatBytes(stats.totalSavings);
        globalItemsEl.textContent = stats.totalItems;
        globalSizeEl.textContent = formatBytes(stats.totalSize);
    }
    
    // Populate table
    const allAssets = await chrome.runtime.sendMessage({ type: 'getAllAssets' });
    if (allAssets) {
        cacheTableBodyEl.innerHTML = ''; // Clear loading message
        allAssets.sort((a,b) => b.lastAccessed - a.lastAccessed).forEach(asset => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${asset.url}</td>
                <td>${formatBytes(asset.size)}</td>
                <td>${new Date(asset.cachedOn).toLocaleString()}</td>
                <td>${new Date(asset.lastAccessed).toLocaleString()}</td>
            `;
            cacheTableBodyEl.appendChild(row);
        });
    }

    // Populate settings
    const settings = await chrome.storage.local.get('settings');
    if (settings.settings?.maxAge) {
        maxAgeSelect.value = settings.settings.maxAge;
    }
}

purgeAllButton.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete all cached data? This cannot be undone.')) {
        chrome.runtime.sendMessage({ type: 'purgeAll' });
        alert('All cache has been cleared.');
        location.reload();
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