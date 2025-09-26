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

async function checkYouTubeVideoAvailability(url) {
  try {
    const urlObj = new URL(url);
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) {
      console.log('❌ No video ID found in URL');
      return false;
    }

    // Use YouTube's oEmbed endpoint to check if video exists and is available
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    
    console.log('🔍 Checking video availability:', { videoId, url });
    const response = await fetch(oembedUrl);
    
    if (!response.ok) {
      console.log('❌ Video not available:', { 
        status: response.status,
        statusText: response.statusText 
      });
      return false;
    }

    const data = await response.json();
    console.log('✅ Video available:', { 
      title: data.title,
      author: data.author_name,
      thumbnailUrl: data.thumbnail_url 
    });
    return true;
  } catch (error) {
    console.error('❌ Error checking video availability:', error);
    return false;
  }
}

function sanitizeYouTubeUrl(url) {
  try {
    // Parse and validate the URL
    const urlObj = new URL(url);
    
    // Ensure it's a YouTube domain
    if (!(urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com')) {
      throw new Error('Not a YouTube URL');
    }
    
    // Ensure proper protocol
    urlObj.protocol = 'https:';
    
    // Ensure www subdomain
    if (urlObj.hostname === 'youtube.com') {
      urlObj.hostname = 'www.youtube.com';
    }
    
    // Keep only essential parameters
    const newParams = new URLSearchParams();
    if (urlObj.searchParams.has('v')) {
      newParams.set('v', urlObj.searchParams.get('v'));
    }
    urlObj.search = newParams.toString();
    
    return urlObj.toString();
  } catch (error) {
    console.error('❌ Error sanitizing YouTube URL:', error);
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
    
    const sanitizedUrl = sanitizeYouTubeUrl(url);
    if (!sanitizedUrl) {
      console.log('❌ Could not sanitize YouTube URL');
      return false;
    }

    const urlObj = new URL(sanitizedUrl);
    if (!urlObj.pathname.includes('/watch')) {
      console.log('❌ Not a YouTube video watch URL');
      return false;
    }

    if (!urlObj.searchParams.has('v')) {
      console.log('❌ Missing video parameter');
      return false;
    }

    // Check if video is available
    const isAvailable = await checkYouTubeVideoAvailability(sanitizedUrl);
    if (!isAvailable) {
      console.log('❌ Video is not available');
      return false;
    }

    console.log('✅ Valid and available YouTube URL:', sanitizedUrl);
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
    
    console.log('🎯 Generating video suggestion with criteria:', {
      topic,
      classification: topicClassification,
      previousCount: previousVideos.length
    });

    async function getVideoUrlFromGemini(isRetry = false, customPrompt = null) {
      const prompt = customPrompt || `Find 1 recent educational YouTube video about ${topic}.

Important Instructions:
1. The video must be from one of these channels: ${popularChannels}
2. Must be a recent video (within last 2 years)
3. Must be a full video (not a Short)
4. Cannot be any of these videos: ${JSON.stringify(previousVideos)}

You MUST respond with ONLY a YouTube video URL and nothing else.
Example of correct response:
https://www.youtube.com/watch?v=abcd12345

RULES:
- Return ONLY the URL
- The URL must start with https://www.youtube.com/watch?v=
- NO other text, NO explanations
- NO line breaks before or after the URL
- NO comments about date/time constraints`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ Gemini API Error:', errorData);
        throw new Error('Failed to get video suggestion');
      }

      const data = await response.json();
      
      console.log('📥 Raw Gemini response:', {
        status: response.status,
        ok: response.ok,
        data: JSON.stringify(data)
      });
      
      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error('❌ Invalid response structure:', data);
        throw new Error('Invalid response structure from Gemini API');
      }
      
      const responseText = data.candidates[0].content.parts[0].text.trim();
      console.log('📝 Raw response text:', responseText);
      
      // Extract URL by looking for https://www.youtube.com/watch?v=
      const youtubeUrl = responseText.split('\n').find(line => 
        line.trim().startsWith('https://www.youtube.com/watch?v=')
      );
      
      if (!youtubeUrl) {
        console.error('❌ No YouTube URL found in response. Response was:', responseText);
        throw new Error('No valid YouTube URL found in response');
      }
      
      const cleanedUrl = youtubeUrl.trim();
      console.log('🔍 Found YouTube URL:', cleanedUrl);

      // cleanedUrl is already validated at this point
      const foundUrl = cleanedUrl;

      // Make sure it's a valid watch URL
      try {
        const urlObj = new URL(foundUrl);
        const videoId = urlObj.searchParams.get('v') || urlObj.pathname.split('/').pop();
        
        if (!videoId) {
          console.error('❌ No video ID found in URL:', foundUrl);
          throw new Error('Invalid YouTube URL format');
        }

        // Convert to standard format
        const standardUrl = `https://www.youtube.com/watch?v=${videoId}`;
        console.log('✅ Standardized YouTube URL:', standardUrl);
        return standardUrl;
        
      } catch (error) {
        console.error('❌ Error processing URL:', {
          url: foundUrl,
          error: error.message,
          response: cleanedResponse
        });
        throw new Error('Failed to process YouTube URL');
      }
    }

    let maxRetries = 5;
    let currentTry = 1;
    let videoUrl = null;

    while (currentTry <= maxRetries) {
      try {
        console.log(`📍 Attempt ${currentTry}/${maxRetries}`);

        // Get a video suggestion
        if (!videoUrl) {
          videoUrl = await getVideoUrlFromGemini();
        }

        // Validate the video
        if (!videoUrl || !(await isValidYoutubeUrl(videoUrl))) {
          console.log('⚠️ Invalid or unavailable video, trying again');
          videoUrl = null;
          currentTry++;
          continue;
        }

        // Check if already suggested
        if (previousVideos.includes(videoUrl)) {
          console.log('⚠️ Video was previously suggested, trying again');
          const retryPrompt = `Find 1 recent educational YouTube video about "${topic}".

Important Instructions:
1. Must be from one of these channels: ${popularChannels}
2. Must be a recent video (within last 2 years)
3. Must be a full video (not a Short)
4. Cannot be any of these videos: ${JSON.stringify(previousVideos)}

Return ONLY the YouTube URL. No other text or explanations.`;
          videoUrl = await getVideoUrlFromGemini(true, retryPrompt);
          currentTry++;
          continue;
        }

        // Video is valid and new
        console.log('✅ Valid video found:', videoUrl);
        previousVideos.push(videoUrl);
        await chrome.storage.local.set({ suggestedVideoUrls: previousVideos });
        return videoUrl;

      } catch (error) {
        console.error(`❌ Error in attempt ${currentTry}:`, error);
        videoUrl = null;
        currentTry++;
      }
    }

    throw new Error(`Failed to find valid video after ${maxRetries} attempts`);

  } catch (error) {
    console.error('❌ Error getting video suggestion:', error);
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
        console.log('🎥 Opening prepared video URL:', nextVideoUrl);
        // Ensure the URL is properly encoded
        const encodedUrl = encodeURI(nextVideoUrl);
        // Open the prepared video URL in a new tab with focus
        await chrome.tabs.create({ 
          url: encodedUrl,
          active: true // Make the new tab active
        });
        await chrome.storage.sync.set({ lastVideoUrl: nextVideoUrl });
        await chrome.storage.local.remove('nextVideoUrl');
      } else if (topic) {
        // If we don't have a prepared video, get one and open it
        console.log('🔄 Getting new video suggestion for topic:', topic);
        const videoUrl = await getYoutubeVideoSuggestion(topic);
        const encodedUrl = encodeURI(videoUrl);
        await chrome.tabs.create({ 
          url: encodedUrl,
          active: true // Make the new tab active
        });
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