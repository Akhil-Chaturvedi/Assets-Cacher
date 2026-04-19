const globalSavingsEl = document.getElementById('global-savings');
const globalItemsEl = document.getElementById('global-items');
const globalSizeEl = document.getElementById('global-size');
const purgeAllButton = document.getElementById('purge-all-button');

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
      if (chrome.runtime.lastError) {
        console.error("Purge All Error:", chrome.runtime.lastError.message);
      }
      alert('Statistics reset.');
      location.reload();
    });
  }
});

document.addEventListener('DOMContentLoaded', populateData);

// React to storage changes instead of polling every 2s
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || area === 'session') {
    populateData();
  }
});
