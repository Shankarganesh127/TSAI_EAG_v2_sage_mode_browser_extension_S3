document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const saveBtn = document.getElementById('save-key');
  const testBtn = document.getElementById('test-key');
  const clearBtn = document.getElementById('clear-key');
  const statusEl = document.getElementById('key-status');

  function setStatus(msg, cls='') {
    statusEl.textContent = msg; statusEl.className = 'status ' + cls;
  }

  chrome.storage.sync.get(['apiKey'], r => {
    if(r.apiKey) {
      apiKeyInput.value = r.apiKey;
      setStatus('API key loaded.', 'ok');
    } else {
      setStatus('No API key saved.', 'err');
    }
  });

  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if(!key){ setStatus('Please enter a key first.', 'err'); return; }
    chrome.storage.sync.set({ apiKey: key }, () => {
      setStatus('Key saved. You can test the connection.', 'ok');
      chrome.runtime.sendMessage({ action:'checkGeminiConnection' }, resp => {
        if(resp?.success) setStatus('Connection successful.', 'ok'); else setStatus('Saved. Test failed: ' + (resp?.error||'Unknown error'), 'err');
      });
    });
  });

  testBtn.addEventListener('click', () => {
    setStatus('Testing...', '');
    chrome.runtime.sendMessage({ action:'checkGeminiConnection' }, resp => {
      if(chrome.runtime.lastError) { setStatus('Runtime error: '+chrome.runtime.lastError.message,'err'); return; }
      if(resp?.success) setStatus('Connection OK.', 'ok'); else setStatus((resp?.error||'Failed'),'err');
    });
  });

  clearBtn.addEventListener('click', () => {
    chrome.storage.sync.remove('apiKey', () => {
      apiKeyInput.value='';
      setStatus('API key cleared.', 'err');
    });
  });
});