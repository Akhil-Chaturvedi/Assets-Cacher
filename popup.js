document.addEventListener('DOMContentLoaded', () => {
    const hostnameEl = document.getElementById('hostname');
    const enabledSwitch = document.getElementById('enabled-switch');
    const itemCountEl = document.getElementById('item-count');
    const cacheSizeEl = document.getElementById('cache-size');
    const purgeButton = document.getElementById('purge-button');
    const savingsSizeEl = document.getElementById('savings-size');
    const optionsLink = document.getElementById('options-link');
    const cacheHitsEl = document.getElementById('cache-hits');
    const cacheMissesEl = document.getElementById('cache-misses');
    const hitRateEl = document.getElementById('hit-rate');
    const container = document.querySelector('.container');

    let currentHostname = '';

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 KB';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function updateUI(state) {
        container.classList.remove('loading');

        if (!state) {
            hostnameEl.textContent = 'Error loading state';
            return;
        }

        hostnameEl.textContent = currentHostname;
        enabledSwitch.checked = state.isEnabled;
        itemCountEl.textContent = state.itemCount;
        cacheSizeEl.textContent = formatBytes(state.totalSize);
        savingsSizeEl.textContent = formatBytes(state.savings);
        purgeButton.disabled = state.itemCount === 0;

        if (state.stats) {
            cacheHitsEl.textContent = state.stats.hits;
            cacheMissesEl.textContent = state.stats.misses;

            const total = state.stats.hits + state.stats.misses;
            const hitRate = total > 0 ? Math.round((state.stats.hits / total) * 100) : 0;
            hitRateEl.textContent = hitRate + '%';
        }
    }

    // Initialize
    container.classList.add('loading');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url) {
            const url = new URL(tabs[0].url);
            if (url.protocol.startsWith('http')) {
                currentHostname = url.hostname;
                chrome.runtime.sendMessage({ type: 'getState', hostname: currentHostname }, (state) => {
                    if (chrome.runtime.lastError) {
                        console.error("Popup Error:", chrome.runtime.lastError.message);
                        container.classList.remove('loading');
                        hostnameEl.textContent = 'Error connecting to extension';
                    } else {
                        updateUI(state);
                    }
                });
            } else {
                container.classList.remove('loading');
                hostnameEl.textContent = "Cannot cache this page";
                container.innerHTML = `
                    <div class="header">
                        <h3>Assets Cacher</h3>
                        <p>Caching is not available for <code>${url.protocol}</code> pages.</p>
                    </div>
                `;
            }
        } else {
            container.classList.remove('loading');
            hostnameEl.textContent = 'No active tab';
        }
    });

    enabledSwitch.addEventListener('change', () => {
        container.classList.add('loading');
        chrome.runtime.sendMessage({
            type: 'toggleSite',
            hostname: currentHostname,
            enabled: enabledSwitch.checked
        }, () => {
            container.classList.remove('loading');
        });
    });

    purgeButton.addEventListener('click', () => {
        container.classList.add('loading');
        chrome.runtime.sendMessage({ type: 'purgeSiteCache', hostname: currentHostname }, () => {
            chrome.runtime.sendMessage({ type: 'getState', hostname: currentHostname }, updateUI);
        });
    });

    optionsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });
});