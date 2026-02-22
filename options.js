const globalSavingsEl = document.getElementById('global-savings');
const globalItemsEl = document.getElementById('global-items');
const globalSizeEl = document.getElementById('global-size');
const purgeAllButton = document.getElementById('purge-all-button');

function formatBytes(bytes) {
    if (bytes === 0) return '0 KB';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function populateData() {
    // Populate stats from background
    const stats = await chrome.runtime.sendMessage({ type: 'getGlobalStats' });
    if (stats) {
        globalSavingsEl.textContent = formatBytes(stats.totalSavings);
        globalItemsEl.textContent = stats.totalItems;
        globalSizeEl.textContent = formatBytes(stats.totalSize);
    }
}

purgeAllButton.addEventListener('click', () => {
    if (confirm('Reset your statistics dashboard?')) {
        chrome.runtime.sendMessage({ type: 'purgeAll' }, () => {
            alert('Statistics reset.');
            location.reload();
        });
    }
});

document.addEventListener('DOMContentLoaded', populateData);
setInterval(populateData, 2000); // Live tick