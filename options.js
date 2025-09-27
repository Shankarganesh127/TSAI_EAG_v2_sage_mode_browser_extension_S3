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
      chrome.runtime.sendMessage({ action:'checkGeminiConnection' }, function handleResp(resp){
        if(resp?.error === 'Check in progress') {
          setStatus('Still checking...','');
          setTimeout(()=> chrome.runtime.sendMessage({action:'checkGeminiConnection'}, handleResp), 400);
          return;
        }
        if(resp?.success) {
          const modelInfo = resp.model ? ` Model: ${resp.model}` : '';
          const latency = typeof resp.ms==='number'? ` (${resp.ms}ms)`:'';
          setStatus('Connection successful.'+modelInfo+latency, 'ok');
        } else {
          let msg = 'Saved. Test failed: ' + (resp?.error||'Unknown error');
          if(resp?.diagnostics){
            const d=resp.diagnostics; const parts=[];
            if(d.status) parts.push('HTTP '+d.status);
            if(d.model) parts.push(d.model);
            if(d.ms) parts.push(d.ms+'ms');
            if(/invalid|permission|unauthorized/i.test(d.message)) parts.push('Check API key / model access');
            if(parts.length) msg += ' ['+parts.join(' | ')+']';
          }
          setStatus(msg,'err');
        }
      });
    });
  });

  testBtn.addEventListener('click', () => {
    setStatus('Testing...', '');
    chrome.runtime.sendMessage({ action:'checkGeminiConnection' }, function handleResp(resp){
      if(chrome.runtime.lastError) { setStatus('Runtime error: '+chrome.runtime.lastError.message,'err'); return; }
      if(resp?.error==='Check in progress') { setStatus('Checking...',''); setTimeout(()=> chrome.runtime.sendMessage({action:'checkGeminiConnection'}, handleResp),400); return; }
      if(resp?.success){
        const modelInfo = resp.model ? ` Model: ${resp.model}` : '';
        const latency = typeof resp.ms==='number'? ` (${resp.ms}ms)`:'';
        setStatus('Connection OK.'+modelInfo+latency,'ok');
      } else {
        let msg = resp?.error||'Failed';
        if(resp?.diagnostics){ const d=resp.diagnostics; const parts=[]; if(d.status) parts.push('HTTP '+d.status); if(d.model) parts.push(d.model); if(d.ms) parts.push(d.ms+'ms'); if(/invalid|permission|unauthorized/i.test(d.message)) parts.push('Check API key / model access'); if(parts.length) msg += ' ['+parts.join(' | ')+']'; }
        setStatus(msg,'err');
      }
    });
  });

  clearBtn.addEventListener('click', () => {
    chrome.storage.sync.remove('apiKey', () => {
      apiKeyInput.value='';
      setStatus('API key cleared.', 'err');
    });
  });
});