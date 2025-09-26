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
    this.url = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent';
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

  async makeRequest(apiKey, requestBody, retryCount = 0) {
    try {
      console.log(`📡 Request attempt ${retryCount + 1}/${this.MAX_RETRIES + 1}`);
      
      const response = await fetch(`${this.url}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
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
        throw new Error(data.error?.message || 'API request failed');
      }

      return data;
    } catch (error) {
      if (retryCount < this.MAX_RETRIES) {
        const delay = this.BASE_DELAY * Math.pow(2, retryCount);
        console.log(`❌ Request failed, retrying in ${delay}ms...`, error.message);
        await this.sleep(delay);
        return this.makeRequest(apiKey, requestBody, retryCount + 1);
      }
      throw error;
    }
  }

  async generateContent(apiKey, prompt) {
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
      const data = await this.makeRequest(apiKey, requestBody);
      
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
      
      throw new Error('Invalid response format from API');
    } catch (error) {
      console.error('Gemini API Error:', error);
      throw error;
    }
  }
}

// Export the API interface
export const GoogleGenerativeAI = new GeminiClient();