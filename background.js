const GEMINI_API_KEY = 'AIzaSyBe4P7dmOiBy6gE9Yys4kk0CHf8r04EC0Q';
const GEMINI_MODEL = 'gemini-2.0-flash';  // Without 'models/' prefix
let modelConfigured = false;
let suggestedVideos = new Set(); // Store suggested video URLs
let contentCheckInterval;

function testConnection() {
  return new Promise((resolve, reject) => {
    if (modelConfigured) {
      resolve({ success: true });
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    // Test with a simple model check
    fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}?key=${GEMINI_API_KEY}`, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      }
    })
      .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) {
          return response.json().then(data => {
            throw new Error(data.error?.message || 'API request failed');
          });
        }
        modelConfigured = true;
        return response.json();
      })
      .then(data => {
        resolve({ success: true, model: data });
      })
      .catch(error => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

// Handle messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkConnection') {
    testConnection()
      .then(result => {
        if (result.model) {
          console.log('Connected to model:', result.model.displayName);
        }
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('API connection failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;  // Will respond asynchronously
  }
});

async function classifyTopic(topic) {
  try {
    console.log('🔍 Topic Classification Request:', {
      topic,
      timestamp: new Date().toISOString()
    });

    const classifyPrompt = `Analyze this topic: "${topic}"
1. What is the main category or field (e.g., Technology, Science, History, etc.)?
2. What are the key aspects or subtopics?
3. Give me 5 closely related topics.
Respond in this exact format:
CATEGORY: [main category]
ASPECTS: [key aspects separated by commas]
RELATED: [related topics separated by commas]`;

    console.log('📤 Gemini Prompt (Topic Classification):', classifyPrompt);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: classifyPrompt }]
        }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('❌ Gemini API Error:', errorData);
      throw new Error('Failed to classify topic');
    }

    const data = await response.json();
    console.log('📥 Gemini Response (Topic Classification):', {
      rawResponse: data,
      extractedText: data.candidates[0].content.parts[0].text.trim()
    });
    return data.candidates[0].content.parts[0].text.trim();
  } catch (error) {
    console.error('❌ Topic Classification Error:', error);
    return null;
  }
}

async function analyzeContent(content, topic) {
  try {
    console.log('🔍 Content Analysis Request:', {
      contentLength: content.length,
      topic,
      timestamp: new Date().toISOString()
    });

    // First, get the main topic and context of the content
    const topicPrompt = `Analyze this webpage content and provide:
1. The main topic or subject matter
2. Key themes or concepts discussed
3. The field or category it belongs to (e.g., Technology, Science, Education)
4. The level of content (beginner, intermediate, advanced)
Respond in this exact format:
TOPIC: [main topic]
THEMES: [key themes]
FIELD: [category]
LEVEL: [level]

Content: "${content.substring(0, 1500)}..."`;

    console.log('📤 Gemini Prompt (Content Analysis):', {
      prompt: topicPrompt,
      contentPreview: content.substring(0, 100) + '...'
    });
    
    const topicResponse = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: topicPrompt }]
        }]
      })
    });

    if (!topicResponse.ok) {
      const errorData = await topicResponse.json();
      console.error('❌ Gemini API Error (Content Analysis):', errorData);
      throw new Error('Failed to get content topic');
    }

    const topicData = await topicResponse.json();
    console.log('📥 Gemini Response (Content Analysis):', {
      rawResponse: topicData,
      extractedText: topicData.candidates[0].content.parts[0].text.trim()
    });
    const contentTopic = topicData.candidates[0].content.parts[0].text.trim();

    console.log('🔄 Starting Topic Classification');
    // Get classification for selected topic
    const topicClassification = await classifyTopic(topic);
    
    // Compare the topics with context
    const comparePrompt = `I have a user selected topic and a webpage's content. Analyze if they are related:

Selected Topic Information:
${topicClassification}

Webpage Content Analysis:
${contentTopic}

Are these directly related or discussing the same subject matter? Consider:
1. The main categories and fields
2. Key themes and concepts
3. Related subtopics
4. The depth and focus of the content

Reply with ONLY "yes" or "no" followed by a confidence score (0-100):
Format: [yes/no]|[score]`;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: comparePrompt }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error('Failed to analyze content');
    }

    const data = await response.json();
    const response_text = data.candidates[0].content.parts[0].text.trim().toLowerCase();
    const [answer, confidenceStr] = response_text.split('|');
    const confidence = parseInt(confidenceStr, 10) || 0;
    
    return {
      contentTopic,
      isRelevant: answer === 'yes',
      confidence: confidence,
      topicDetails: contentTopic // This contains the structured content analysis
    };
  } catch (error) {
    console.error('Error analyzing content:', error);
    return {
      contentTopic: 'Error analyzing content',
      isRelevant: false,
      confidence: 0,
      topicDetails: null
    };
  }
}

async function isValidYoutubeUrl(url) {
  try {
    // First check URL format
    const urlObj = new URL(url);
    if (!(urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com')) {
      console.log('❌ Invalid YouTube domain:', urlObj.hostname);
      return false;
    }
    
    if (!urlObj.pathname.startsWith('/watch')) {
      console.log('❌ Not a video URL:', urlObj.pathname);
      return false;
    }
    
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) {
      console.log('❌ No video ID found in URL');
      return false;
    }

    // Now check if video exists and is available
    console.log('🔍 Checking video availability for ID:', videoId);
    const response = await fetch(`https://www.youtube.com/oembed?url=${url}&format=json`);
    
    if (!response.ok) {
      console.log('❌ Video not available or not public');
      return false;
    }

    const data = await response.json();
    console.log('✅ Video found:', {
      title: data.title,
      author: data.author_name,
      type: data.type
    });
    
    return true;
  } catch (error) {
    console.error('❌ Error validating YouTube URL:', error);
    return false;
  }
}

async function getYoutubeVideoSuggestion(topic) {
  try {
    console.log('🎥 Starting Video Suggestion Request:', {
      topic,
      timestamp: new Date().toISOString()
    });

    // Get topic classification first
    const topicClassification = await classifyTopic(topic);
    console.log('📋 Topic Classification for Video:', topicClassification);
    
    // Get previously suggested videos from storage
    const storageData = await chrome.storage.local.get('suggestedVideoUrls');
    const previousVideos = storageData.suggestedVideoUrls || [];
    console.log('🎬 Previously Suggested Videos:', previousVideos);
    
    const prompt = `Search for and suggest a YouTube video about this topic:
${topicClassification}

Requirements for the video:
1. Must be from a popular tech or educational channel (e.g., TED, Google AI, MIT, Stanford)
2. Must be a recent video (within last 2 years) to ensure relevance
3. Must be a full-length video (not a short)
4. Must NOT be any of these previously suggested videos: ${JSON.stringify(previousVideos)}

Instructions:
1. Search for "latest [topic] tutorial" or "[topic] explained" on YouTube
2. Look for videos with high view counts and positive ratings
3. Verify the video exists and is publicly available
4. Return ONLY a single, valid, full YouTube video URL in this format: https://www.youtube.com/watch?v=VIDEOID

Do not include any text, explanation, or formatting - just the raw YouTube URL.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('❌ Gemini API Error (Video Suggestion):', errorData);
      throw new Error('Failed to get video suggestion');
    }

    const data = await response.json();
    console.log('📥 Gemini Response (Video Suggestion):', {
      rawResponse: data,
      extractedUrl: data.candidates[0].content.parts[0].text.trim()
    });
    
    let videoUrl = data.candidates[0].content.parts[0].text.trim();
    
    // Clean up the URL
    videoUrl = videoUrl.replace(/[\n\r\t]/g, '').trim();
    if (!videoUrl.startsWith('http')) {
      videoUrl = 'https://' + videoUrl;
    }
    
    // Validate the YouTube URL
    console.log('🔍 Validating YouTube URL:', videoUrl);
    
    // Try up to 3 times to get a valid video
    let maxRetries = 3;
    while (maxRetries > 0) {
      if (await isValidYoutubeUrl(videoUrl)) {
        // Update storage with new video URL
        previousVideos.push(videoUrl);
        await chrome.storage.local.set({ suggestedVideoUrls: previousVideos });
        console.log('✅ New video URL saved:', videoUrl);
        return videoUrl;
      }
      
      console.log(`⚠️ Retry ${4 - maxRetries}/3: Getting new video suggestion`);
      maxRetries--;
      
      if (maxRetries > 0) {
        // Try getting another video suggestion
        const retryResponse = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: prompt }]
            }]
          })
        });
        
        const retryData = await retryResponse.json();
        videoUrl = retryData.candidates[0].content.parts[0].text.trim().replace(/[\n\r\t]/g, '');
      }
    }
    
    console.error('❌ Failed to get valid YouTube video after 3 attempts');
    throw new Error('Could not get valid YouTube video suggestion');
  } catch (error) {
    console.error('Error getting video suggestion:', error);
    throw error;
  }
}

async function prepareNextVideo(topic) {
  try {
    const videoUrl = await getYoutubeVideoSuggestion(topic);
    await chrome.storage.local.set({ nextVideoUrl: videoUrl });
    return videoUrl;
  } catch (error) {
    console.error('Error preparing next video:', error);
    return null;
  }
}

async function checkActiveTabContent() {
  try {
    console.log('🔄 Starting Active Tab Content Check');
    
    const { enabled, topic } = await chrome.storage.sync.get(['enabled', 'topic']);
    if (!enabled || !topic) {
      console.log('⏸️ Extension disabled or no topic set:', { enabled, topic });
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.log('⚠️ No active tab found');
      return;
    }
    
    console.log('📄 Analyzing Tab:', {
      title: tab.title,
      url: tab.url
    });

    // Inject content script to get page content
    console.log('📑 Extracting page content...');
    const [{ result: content }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Get all text content from the page
        const extractText = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent;
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return '';
          return Array.from(node.childNodes).map(extractText).join(' ');
        };
        const text = extractText(document.body).replace(/\\s+/g, ' ').trim();
        console.log('📝 Extracted Content Length:', text.length);
        return text;
      },
    });
    
    console.log('📊 Content Stats:', {
      length: content.length,
      preview: content.substring(0, 100) + '...'
    });

    const [contentAnalysis, topicClassification] = await Promise.all([
      analyzeContent(content, topic),
      classifyTopic(topic)
    ]);

    console.log('📊 Analysis Results:', {
      contentAnalysis,
      topicClassification,
      isRelevant: contentAnalysis.isRelevant,
      confidence: contentAnalysis.confidence
    });

    const currentState = {
      currentContent: content.substring(0, 100) + "...",
      contentAnalysis: contentAnalysis.contentTopic,
      selectedTopic: topic,
      topicClassification: topicClassification,
      isRelevant: contentAnalysis.isRelevant,
      confidence: contentAnalysis.confidence || 0,
      timestamp: new Date().toISOString(),
      tabId: tab.id
    };
    
    console.log('💾 Saving Current State:', currentState);

    await chrome.storage.local.set({ currentState });

    if (contentAnalysis.isRelevant) {
      console.log('✅ Content is relevant to topic, stopping timer');
      // Stop the timer if content is relevant
      chrome.alarms.clear('youtubeSuggestion');
      await chrome.storage.sync.set({ timerEndTime: null });
    } else {
      console.log('⚠️ Content is not relevant, checking video status');
      // Check if we have a next video ready
      const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
      if (!nextVideoUrl) {
        console.log('🎥 No video ready, preparing next video suggestion');
        // Prepare next video if we don't have one
        await prepareNextVideo(topic);
      } else {
        console.log('✓ Next video is already prepared:', nextVideoUrl);
      }

      // Restart timer if not already running
      const { timerEndTime } = await chrome.storage.sync.get('timerEndTime');
      if (!timerEndTime) {
        const { timer = 5 } = await chrome.storage.sync.get('timer');
        chrome.alarms.create('youtubeSuggestion', { delayInMinutes: timer });
        await chrome.storage.sync.set({ timerEndTime: Date.now() + timer * 60 * 1000 });
      }
    }
  } catch (error) {
    console.error('Error checking tab content:', error);
  }
}

// Handle messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getVideoSuggestion') {
    getYoutubeVideoSuggestion(message.topic)
      .then(videoUrl => {
        chrome.storage.sync.set({ lastVideoUrl: videoUrl }, () => {
          sendResponse({ success: true, videoUrl });
        });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

// Set up content monitoring
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startMonitoring') {
    if (!contentCheckInterval) {
      contentCheckInterval = setInterval(checkActiveTabContent, 10000); // Check every 10 seconds
      checkActiveTabContent(); // Initial check
    }
    sendResponse({ success: true });
  } else if (message.action === 'stopMonitoring') {
    if (contentCheckInterval) {
      clearInterval(contentCheckInterval);
      contentCheckInterval = null;
    }
    sendResponse({ success: true });
  }
  return true;
});

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('Alarm triggered:', alarm.name);
  if (alarm.name === 'youtubeSuggestion') {
    try {
      // Get the current state and next video URL
      const { currentState } = await chrome.storage.local.get('currentState');
      const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
      const { topic } = await chrome.storage.sync.get(['topic']);

      if (currentState && currentState.tabId && !currentState.isRelevant) {
        // Close the irrelevant tab
        await chrome.tabs.remove(currentState.tabId);
      }

      if (nextVideoUrl) {
        // Open the prepared video URL in a new tab
        await chrome.tabs.create({ url: nextVideoUrl });
        await chrome.storage.sync.set({ lastVideoUrl: nextVideoUrl });
        await chrome.storage.local.remove('nextVideoUrl');
      } else if (topic) {
        // If we don't have a prepared video, get one and open it
        const videoUrl = await getYoutubeVideoSuggestion(topic);
        await chrome.tabs.create({ url: videoUrl });
        await chrome.storage.sync.set({ lastVideoUrl: videoUrl });
      }

      // Prepare the next video
      if (topic) {
        await prepareNextVideo(topic);
      }
    } catch (error) {
      console.error('Error handling alarm:', error);
    }
  }
});