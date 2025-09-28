// Content script: extracts structured page data & provides highlight UI
console.log('[SageMode] content.js loaded');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    if (request.action === 'extractStructuredContent') {
      const data = extractStructuredContent();
      sendResponse({ success: true, data });
      return true;
    }
    if (request.action === 'updateHighlight') {
      updateHighlight(request.color, request.reason || 'Analyzing relevance...');
      sendResponse({ success: true });
      return true;
    }
  } catch (e) {
    console.error('[SageMode] content script error:', e);
    sendResponse({ success: false, error: e.message });
  }
  return true; // async
});

function extractStructuredContent() {
  const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el ? el.getAttribute('content') : '';
  };

  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

  const headers = {
    h1: Array.from(document.querySelectorAll('h1')).map(h => clean(h.textContent)),
    h2: Array.from(document.querySelectorAll('h2')).map(h => clean(h.textContent)),
    h3: Array.from(document.querySelectorAll('h3')).map(h => clean(h.textContent))
  };

  const main = document.querySelector('main, article, [role="main"], .content, #content') || document.body;

  const extractText = (node) => {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const skip = ['SCRIPT','STYLE','NOSCRIPT','IFRAME','SVG','FOOTER','NAV','HEADER','ASIDE'];
    if (skip.includes(node.tagName)) return '';
    return Array.from(node.childNodes).map(extractText).join(' ');
  };

  const bodyRaw = extractText(main);
  const body = clean(bodyRaw).slice(0, 8000); // limit tokens

  return {
    title: document.title,
    url: location.href,
    description: meta('description') || meta('og:description'),
    keywords: meta('keywords'),
    og: {
      siteName: meta('og:site_name'),
      type: meta('og:type')
    },
    headers,
    body
  };
}

function updateHighlight(color = 'transparent', reason) {
  document.documentElement.style.setProperty('--sagemode-outline-color', color);
  let box = document.getElementById('sagemode-page-indicator');
  if (!box) {
    const style = document.createElement('style');
    style.textContent = `html { box-shadow: inset 0 0 0 5px var(--sagemode-outline-color, transparent) !important; }
#sagemode-page-indicator { position: fixed; top: 10px; right: 10px; background: rgba(0,0,0,.75); color: #fff; font: 12px/1.4 system-ui, Arial, sans-serif; padding: 8px 10px; border-radius: 6px; z-index: 2147483647; max-width: 240px; box-shadow: 0 2px 6px rgba(0,0,0,.4); }
#sagemode-page-indicator strong { display:block; font-size:12px; margin-bottom:4px; }
`;    document.head.appendChild(style);
    box = document.createElement('div');
    box.id = 'sagemode-page-indicator';
    document.body.appendChild(box);
  }
  box.innerHTML = `<strong>Sage Mode</strong>${escapeHtml(reason)}`;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
}

// ---------------- Dynamic Change / SPA Navigation Detection -----------------
// Goal: Inform background script when meaningful content or in-tab navigation changes
// so relevance can be re-evaluated promptly (instead of waiting only for polling).

(function initDynamicChangeDetection(){
  try {
    let lastSignature = null;
    let pendingTimer = null;
    let lastDispatch = 0;
    const MIN_INTERVAL = 2500; // minimum ms between background notifications

    function computeSignature(){
      try {
        const data = extractStructuredContent();
        // Use a light signature: title + first 400 chars of body + first 2 h1/h2
        const h1 = (data.headers.h1||[]).slice(0,2).join('|');
        const h2 = (data.headers.h2||[]).slice(0,2).join('|');
        const bodySlice = (data.body||'').slice(0,400);
        return [data.title, bodySlice, h1, h2].join('@@');
      } catch { return null; }
    }

    function maybeNotify(force){
      const now = Date.now();
      if(!force && (now - lastDispatch) < MIN_INTERVAL) return; // throttle
      const sig = computeSignature();
      if(!sig) return;
      if(!force && sig === lastSignature) return; // no change
      lastSignature = sig;
      lastDispatch = now;
      chrome.runtime.sendMessage({action:'pageSoftChange', signature:sig});
    }

    function scheduleCheck(){
      if(pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(()=>{ pendingTimer=null; maybeNotify(false); }, 800);
    }

    // Mutation observer on main content region / body
    const target = document.querySelector('main, article, [role="main"], .content, #content') || document.body;
    if(target && window.MutationObserver){
      const obs = new MutationObserver(mutations=>{
        // Ignore attribute-only changes that do not modify text content
        if(!mutations.some(m=> m.type==='characterData' || m.type==='childList')) return;
        scheduleCheck();
      });
      obs.observe(target,{subtree:true, childList:true, characterData:true});
    }

    // SPA navigation detection via History API patch
    function hookHistoryMethod(name){
      const orig = history[name];
      if(typeof orig !== 'function') return;
      history[name] = function(...args){
        const ret = orig.apply(this,args);
        // Give the DOM a brief chance to update
        setTimeout(()=> maybeNotify(true), 150);
        return ret;
      };
    }
    hookHistoryMethod('pushState');
    hookHistoryMethod('replaceState');
    window.addEventListener('popstate', ()=> setTimeout(()=> maybeNotify(true), 120));

    // Initial baseline signature
    lastSignature = computeSignature();
  } catch(e){
    console.warn('[SageMode] dynamic change detection init failed:', e.message);
  }
})();
