// @google/generative-ai SDK

/**
 * Gemini API client with rate limiting and quota handling
 */
class GeminiClient {
  constructor() {
    this.lastRequestTime = 0;
    this.MIN_REQUEST_INTERVAL = 1000; // Minimum 1 second between requests
    this.MAX_RETRIES = 3;
    this.BASE_DELAY = 1000;
    // Ordered model preference list; will try each until one succeeds
    this.modelCandidates = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-exp',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-1.5-pro'
    ];
    this.currentModelIndex = 0;
    this.availableModelsCache = null;
    this.modelsRefreshed = false;

    // --- Lightweight logging state (ring buffer in-memory) ---------
    this._logBuffer = [];
    this.MAX_LOG_ENTRIES = 80; // keep the last 80 prompt/response pairs
    this.loggingEnabled = true; // can be toggled later if needed
    // Attempt to pick up a stored toggle (optional; silent failure otherwise)
    try {
      if(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync){
        chrome.storage.sync.get(['logGemini'], r => {
          if(typeof r.logGemini === 'boolean') this.loggingEnabled = r.logGemini;
        });
        chrome.storage.onChanged.addListener((changes, area)=>{
          if(area==='sync' && changes.logGemini){
            this.loggingEnabled = !!changes.logGemini.newValue;
          }
        });
      }
    } catch(_) { /* ignore */ }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      console.log(`🕒 Rate limiting: Waiting ${waitTime}ms before next request`);
      await this.sleep(waitTime);
    }
    this.lastRequestTime = Date.now();
  }

  extractRetryDelay(error) {
    if (!error?.message) return this.BASE_DELAY;
    const match = error.message.match(/retry in ([\d.]+)s/);
    return match ? parseFloat(match[1]) * 1000 : this.BASE_DELAY;
  }

  buildUrl(model) {
    return `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;
  }

  rotateModel() {
    if (this.currentModelIndex < this.modelCandidates.length - 1) {
      this.currentModelIndex += 1;
      console.warn('[Gemini] Rotating to fallback model:', this.modelCandidates[this.currentModelIndex]);
      return true;
    }
    return false;
  }

  getCurrentModel() {
    return this.modelCandidates[this.currentModelIndex];
  }

  async refreshAvailableModels(apiKey) {
    try {
      await this.waitForRateLimit();
      const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
      const res = await fetch(url);
      if(!res.ok){ console.warn('[Gemini] Model list fetch failed:', res.status); return null; }
      const data = await res.json();
      const names=(data.models||[]).map(m=> m.name?.split('/').pop()).filter(Boolean);
      this.availableModelsCache = names;
      const preferred=[
        'gemini-2.0-flash','gemini-2.0-flash-exp','gemini-1.5-flash','gemini-1.5-flash-8b','gemini-1.5-pro','gemini-1.5-pro-exp','gemini-1.0-pro'
      ];
      const newOrder = preferred.filter(m=> names.includes(m));
      if(newOrder.length){
        this.modelCandidates = newOrder;
        this.currentModelIndex = 0;
        console.warn('[Gemini] Adapted modelCandidates after discovery:', this.modelCandidates);
      } else {
        console.warn('[Gemini] No preferred models found; keeping existing order');
      }
      this.modelsRefreshed = true;
      return names;
    } catch(e){
      console.warn('[Gemini] refreshAvailableModels error:', e.message);
      return null;
    }
  }

  async makeRequest(apiKey, requestBody, retryCount = 0, options = {}) {
    try {
      console.log(`📡 Request attempt ${retryCount + 1}/${this.MAX_RETRIES + 1}`);
      const model = this.modelCandidates[this.currentModelIndex];
      const url = `${this.buildUrl(model)}?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: options.signal
      });

      const data = await response.json();

      if (!response.ok) {
        // Handle quota exceeded
        if (response.status === 429) {
          const error = data.error || {};
          const retryDelay = this.extractRetryDelay(error);
          
          if (retryCount < this.MAX_RETRIES) {
            console.log(`⚠️ Quota exceeded. Waiting ${retryDelay/1000}s before retry...`);
            await this.sleep(retryDelay);
            return this.makeRequest(apiKey, requestBody, retryCount + 1);
          }
        }
        // Some errors we can try a different model for (e.g., model not found / 404 or permission)
        if ([404, 400, 403].includes(response.status)) {
          console.warn(`[Gemini] Model ${model} failed with status ${response.status}: ${data.error?.message}`);
          if(!this.modelsRefreshed){ await this.refreshAvailableModels(apiKey); }
          if (this.rotateModel()) {
            return this.makeRequest(apiKey, requestBody, retryCount); // same retryCount; model changed
          }
        }
        const enrichedError = new Error(data.error?.message || 'API request failed');
        enrichedError.status = response.status;
        enrichedError.raw = data;
        enrichedError.availableModels = this.availableModelsCache;
        throw enrichedError;
      }

      return data;
    } catch (error) {
      if (retryCount < this.MAX_RETRIES) {
        const delay = this.BASE_DELAY * Math.pow(2, retryCount);
        console.log(`❌ Request failed, retrying in ${delay}ms...`, error.message);
        await this.sleep(delay);
        return this.makeRequest(apiKey, requestBody, retryCount + 1, options);
      }
      throw error;
    }
  }

  // ------------- Logging helpers ----------------------------------
  _pushLog(entry){
    if(!this.loggingEnabled) return;
    try {
      entry.ts = Date.now();
      entry.model = this.getCurrentModel();
      this._logBuffer.push(entry);
      if(this._logBuffer.length > this.MAX_LOG_ENTRIES){
        this._logBuffer.splice(0, this._logBuffer.length - this.MAX_LOG_ENTRIES);
      }
      // Persist a shallow copy occasionally (throttle by time) to chrome.storage.local
      if(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
        // Flush at most every 1500ms
        if(!this._lastFlushTs || (Date.now() - this._lastFlushTs) > 1500){
          this._lastFlushTs = Date.now();
          // Store a trimmed version (avoid huge memory / token leakage)
            const sanitized = this._logBuffer.map(l=>({
              ts:l.ts,
              model:l.model,
              phase:l.phase,
              kind:l.kind,
              promptPreview:l.promptPreview,
              promptLen:l.promptLen,
              responsePreview:l.responsePreview,
              responseLen:l.responseLen,
              ms:l.ms,
              attempt:l.attempt,
              status:l.status,
              error:l.error
            }));
            chrome.storage.local.set({geminiLogs:sanitized});
        }
      }
    } catch(e){ /* silent */ }
  }

  _logPrompt(kind, prompt, attempt){
    if(!this.loggingEnabled) return;
    const preview = (prompt||'').slice(0,300);
    console.log('[Gemini][PROMPT]', {kind, attempt, model:this.getCurrentModel(), preview, length: prompt.length});
    this._pushLog({phase:'prompt', kind, attempt, promptPreview:preview, promptLen:prompt.length});
  }
  _logResponse(kind, prompt, response, started, attempt){
    if(!this.loggingEnabled) return;
    const ms = Date.now()-started;
    const rPrev = (response||'').slice(0,320);
    console.log('[Gemini][RESPONSE]', {kind, attempt, model:this.getCurrentModel(), ms, preview:rPrev, length: response? response.length:0});
    this._pushLog({phase:'response', kind, attempt, promptPreview:(prompt||'').slice(0,180), promptLen:prompt?prompt.length:0, responsePreview:rPrev, responseLen:response?response.length:0, ms});
  }
  _logError(kind, prompt, error, started, attempt){
    if(!this.loggingEnabled) return;
    const ms = Date.now()-started;
    console.warn('[Gemini][ERROR]', {kind, attempt, model:this.getCurrentModel(), ms, message:error.message, status:error.status});
    this._pushLog({phase:'error', kind, attempt, promptPreview:(prompt||'').slice(0,180), promptLen:prompt?prompt.length:0, error:error.message, status:error.status, ms});
  }

  async generateContent(apiKey, prompt, opts = {}) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      throw new Error('Missing or invalid API key');
    }
    // Apply rate limiting
    await this.waitForRateLimit();

    // Optimize request to minimize token usage
    const requestBody = {
      contents: [{
        parts: [{
          text: prompt
        }]
      }],
      safetySettings: [{
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      }],
      generationConfig: {
        maxOutputTokens: 500, // Reduced to help with quotas
        temperature: 0.7,
        topK: 40,
        topP: 0.95
      }
    };

    const started = Date.now();
    this._logPrompt('text', prompt, 1);
    try {
      const data = await this.makeRequest(apiKey, requestBody, 0, opts);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        this._logResponse('text', prompt, text, started, 1);
        return text;
      }
      const err = new Error('Invalid response format from API');
      err.raw = data;
      this._logError('text', prompt, err, started, 1);
      throw err;
    } catch (error) {
      this._logError('text', prompt, error, started, 1);
      console.error('[Gemini] API Error:', {
        message: error.message,
        status: error.status,
        modelTried: this.modelCandidates[this.currentModelIndex],
        raw: error.raw,
        availableModels: error.availableModels
      });
      throw error;
    }
  }

  async generateJson(apiKey, prompt, opts = {}) {
    // Attempt structured JSON response; fall back to plain text if unsupported
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      throw new Error('Missing or invalid API key');
    }
    await this.waitForRateLimit();
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 400,
        temperature: 0.4,
        topK: 32,
        topP: 0.9,
        responseMimeType: 'application/json'
      }
    };
    const started = Date.now();
    this._logPrompt('json', prompt, 1);
    try {
      const data = await this.makeRequest(apiKey, requestBody, 0, opts);
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!raw){
        const err = new Error('Empty JSON response');
        this._logError('json', prompt, err, started, 1);
        throw err;
      }
      this._logResponse('json', prompt, raw, started, 1);
      return raw;
    } catch (error) {
      this._logError('json', prompt, error, started, 1);
      console.warn('[Gemini] JSON generation failed, falling back to plain text:', error.message);
      throw error;
    }
  }
}

// Export the API interface
export const GoogleGenerativeAI = new GeminiClient();