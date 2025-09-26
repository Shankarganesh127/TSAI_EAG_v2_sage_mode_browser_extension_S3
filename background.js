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

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);
    if (!(urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com')) {
      return null;
    }
    
    if (urlObj.pathname === '/watch') {
      return urlObj.searchParams.get('v');
    }
    
    if (urlObj.pathname.startsWith('/v/')) {
      return urlObj.pathname.split('/')[2];
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error parsing URL:', error);
    return null;
  }
}

function isYouTubeUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com';
  } catch {
    return false;
  }
}

async function isValidYoutubeUrl(url) {
  try {
    console.log('🔍 Validating YouTube URL:', url);
    
    if (!isYouTubeUrl(url)) {
      console.log('❌ Not a YouTube URL');
      return false;
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      console.log('❌ Could not extract video ID');
      return false;
    }

    console.log('✅ Valid YouTube URL format with video ID:', videoId);
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

    // Prepare a list of popular educational channels
    const popularChannels = [
      'TED',
      'TEDx Talks',
      'MIT OpenCourseWare',
      'Stanford',
      'Google Developers',
      'freeCodeCamp.org',
      'Coursera',
      'Khan Academy',
      'Udacity'
    ].join(', ');
    
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
    
    const responseText = data.candidates[0].content.parts[0].text.trim();
    console.log('📝 Raw response:', responseText);
    
    // Extract URL using regex
    const urlMatch = responseText.match(/https?:\/\/(www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/);
    if (!urlMatch) {
      throw new Error('No valid YouTube URL found in response');
    }
    
    let videoUrl = urlMatch[0];
    console.log('🔍 Extracted video URL:', videoUrl);
    
    // Validate the YouTube URL
    let maxRetries = 3;
    let currentTry = 1;
    
    while (currentTry <= maxRetries) {
      console.log(`📍 Attempt ${currentTry}/${maxRetries}`);
      
      if (await isValidYoutubeUrl(videoUrl)) {
        // Check if this video was already suggested
        if (previousVideos.includes(videoUrl)) {
          console.log('⚠️ Video was previously suggested, trying again');
          currentTry++;
          continue;
        }
        
        // Update storage with new video URL
        previousVideos.push(videoUrl);
        await chrome.storage.local.set({ suggestedVideoUrls: previousVideos });
        console.log('✅ New video URL saved:', videoUrl);
        return videoUrl;
      }
      
      if (currentTry < maxRetries) {
        console.log(`⚠️ Retry ${currentTry}/${maxRetries}: Getting new video suggestion`);
        const retryPrompt = `Give me a different educational YouTube video URL about "${topic}" from one of these channels: ${popularChannels}. The video must be from the last 2 years and be a full video (not a Short). Only return the video URL, nothing else.`;
        
        const retryResponse = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: retryPrompt }]
            }]
          })
        });
        
        const retryData = await retryResponse.json();
        const retryText = retryData.candidates[0].content.parts[0].text.trim();
        const retryMatch = retryText.match(/https?:\/\/(www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/);
        
        if (retryMatch) {
          videoUrl = retryMatch[0];
          console.log('🔄 Got new video URL:', videoUrl);
        }
      }
      
      currentTry++;
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
    
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      console.log('⏭️ Skipping browser internal page');
      return;
    }
    
    console.log('📄 Analyzing Tab:', {
      title: tab.title,
      url: tab.url
    });

    // Get the page content
    const content = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => {
        const extractText = (node) => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent;
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return '';
          return Array.from(node.childNodes).map(extractText).join(' ');
        };
        return extractText(document.body).replace(/\\s+/g, ' ').trim();
      }
    });

    if (!content || !content[0]?.result) {
      console.log('⚠️ No content found on page');
      return;
    }

    const pageText = content[0].result;
    if (!pageText.trim()) {
      console.log('⚠️ Empty page content');
      return;
    }

    console.log('📝 Retrieved page content:', pageText.slice(0, 100) + '...');

    // Analyze the content
    const pageTopics = await analyzePageContent(pageText);
    if (!pageTopics || pageTopics.length === 0) {
      console.log('⚠️ No topics extracted from page');
      return;
    }

    console.log('🏷️ Page topics:', pageTopics);

    // Compare with user's topic
    const { isRelevant, confidence } = await compareTopics(topic, pageTopics);
    console.log('🔍 Topic comparison:', { isRelevant, confidence });

    // Save current state for UI
    const currentState = {
      currentContent: pageText.substring(0, 100) + "...",
      contentTopics: pageTopics,
      selectedTopic: topic,
      isRelevant: isRelevant,
      confidence: confidence,
      timestamp: new Date().toISOString(),
      tabId: tab.id
    };
    
    console.log('💾 Saving Current State:', currentState);
    await chrome.storage.local.set({ currentState });

    // Handle video suggestion based on relevance
    if (isRelevant && confidence >= 0.7) {
      console.log('✅ Content is relevant to topic, stopping timer');
      chrome.alarms.clear('youtubeSuggestion');
      await chrome.storage.sync.set({ timerEndTime: null });
    } else {
      console.log('⚠️ Content not relevant enough, checking video status');
      // Check if we have a next video ready
      const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
      if (!nextVideoUrl) {
        console.log('🎥 No video ready, preparing next video suggestion');
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
    console.error('❌ Error checking active tab content:', error);
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

// Function to analyze content topic using Gemini
async function analyzePageContent(content) {
  try {
    console.log('🔍 Analyzing page content...');
    const prompt = `Analyze this webpage content and identify its main topic. 
    Content: "${content.substring(0, 1500)}..."
    
    Respond in this exact format:
    TOPIC: [main topic in 2-3 words]
    FIELD: [general field/category]
    KEYWORDS: [5 most relevant keywords]`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error('Failed to analyze content');
    }

    const data = await response.json();
    console.log('📝 Content Analysis:', data.candidates[0].content.parts[0].text);
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('❌ Content analysis error:', error);
    return null;
  }
}

// Function to compare topics
async function compareTopics(contentAnalysis, selectedTopic) {
  try {
    console.log('🔄 Comparing topics:', { contentAnalysis, selectedTopic });
    const prompt = `Compare these two topics and determine if they are directly related:

    Selected Topic: "${selectedTopic}"
    Page Content Topic: "${contentAnalysis}"

    Consider:
    1. Direct topic match
    2. Parent/child relationship
    3. Related field/category
    4. Shared keywords

    Respond with only "yes" or "no" followed by a confidence score (0-100).
    Format: answer|score`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error('Failed to compare topics');
    }

    const data = await response.json();
    const result = data.candidates[0].content.parts[0].text.trim().toLowerCase();
    const [match, score] = result.split('|');
    
    console.log('📊 Topic Comparison Result:', { match, score });
    return {
      isMatch: match === 'yes',
      confidence: parseInt(score, 10) || 0
    };
  } catch (error) {
    console.error('❌ Topic comparison error:', error);
    return { isMatch: false, confidence: 0 };
  }
}

// Set up content monitoring
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startMonitoring') {
    console.log('▶️ Starting content monitoring');
    if (!contentCheckInterval) {
      contentCheckInterval = setInterval(checkActiveTabContent, 10000); // Check every 10 seconds
      checkActiveTabContent(); // Initial check
    }
    sendResponse({ success: true });
  } else if (message.action === 'stopMonitoring') {
    console.log('⏹️ Stopping content monitoring');
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