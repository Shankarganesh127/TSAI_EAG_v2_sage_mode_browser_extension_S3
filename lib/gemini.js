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
          if (this.rotateModel()) {
            return this.makeRequest(apiKey, requestBody, retryCount); // same retryCount; model changed
          }
        }
        const enrichedError = new Error(data.error?.message || 'API request failed');
        enrichedError.status = response.status;
        enrichedError.raw = data;
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

    try {
      const data = await this.makeRequest(apiKey, requestBody, 0, opts);
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
      const err = new Error('Invalid response format from API');
      err.raw = data;
      throw err;
    } catch (error) {
      console.error('[Gemini] API Error:', {
        message: error.message,
        status: error.status,
        modelTried: this.modelCandidates[this.currentModelIndex],
        raw: error.raw
      });
      throw error;
    }
  }
}

// Export the API interface
export const GoogleGenerativeAI = new GeminiClient();