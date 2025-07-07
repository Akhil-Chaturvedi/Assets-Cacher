document.addEventListener('DOMContentLoaded', () => {
    const hostnameEl = document.getElementById('hostname');
    const enabledSwitch = document.getElementById('enabled-switch');
    const itemCountEl = document.getElementById('item-count');
    const cacheSizeEl = document.getElementById('cache-size');
    const purgeButton = document.getElementById('purge-button');
    const savingsSizeEl = document.getElementById('savings-size');
    const optionsLink = document.getElementById('options-link');

    let currentHostname = '';

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 KB';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function updateUI(state) {
        // CHANGE: Added a check to ensure state object exists before updating UI.
        if (!state) return; 
        
        hostnameEl.textContent = currentHostname;
        enabledSwitch.checked = state.isEnabled;
        itemCountEl.textContent = state.itemCount;
        cacheSizeEl.textContent = formatBytes(state.totalSize);
        savingsSizeEl.textContent = formatBytes(state.savings);
        purgeButton.disabled = state.itemCount === 0;
    }

    // Get current tab and initialize UI
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url) {
            const url = new URL(tabs[0].url);
            if (url.protocol.startsWith('http')) {
                currentHostname = url.hostname;
                chrome.runtime.sendMessage({ type: 'getState', hostname: currentHostname }, (state) => {
                    if (chrome.runtime.lastError) {
                        console.error("Popup Error:", chrome.runtime.lastError.message);
                    } else {
                        updateUI(state);
                    }
                });
            } else {
                hostnameEl.textContent = "Cannot cache this page";
                document.querySelector('.container').innerHTML = `<p>Caching is not available for internal <code>${url.protocol}</code> pages.</p>`;
            }
        }
    });

    // --- Event Listeners ---
    enabledSwitch.addEventListener('change', () => {
        chrome.runtime.sendMessage({
            type: 'toggleSite',
            hostname: currentHostname,
            enabled: enabledSwitch.checked
        });
    });

    purgeButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'purgeSiteCache', hostname: currentHostname }, () => {
             chrome.runtime.sendMessage({ type: 'getState', hostname: currentHostname }, updateUI);
        });
    });

    optionsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });
});