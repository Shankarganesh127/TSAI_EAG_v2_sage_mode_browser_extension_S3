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

async function analyzeContent(content, topic) {
  try {
    // First, get the main topic of the content
    const topicPrompt = `Analyze this webpage content and tell me its main topic or subject matter in 2-3 words: "${content.substring(0, 1000)}..."`;
    
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
      throw new Error('Failed to get content topic');
    }

    const topicData = await topicResponse.json();
    const contentTopic = topicData.candidates[0].content.parts[0].text.trim();

    // Now compare the topics
    const comparePrompt = `Compare these two topics and tell me if they are directly related. Reply with ONLY "yes" or "no":
    Topic 1: "${topic}"
    Topic 2: "${contentTopic}"`;
    
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
    const answer = data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return {
      contentTopic,
      isRelevant: answer === 'yes'
    };
  } catch (error) {
    console.error('Error analyzing content:', error);
    return {
      contentTopic: 'Error analyzing content',
      isRelevant: false
    };
  }
}

function isValidYoutubeUrl(url) {
  try {
    const urlObj = new URL(url);
    return (
      (urlObj.hostname === 'www.youtube.com' || urlObj.hostname === 'youtube.com') &&
      (urlObj.pathname === '/watch' || urlObj.pathname.startsWith('/playlist'))
    );
  } catch {
    return false;
  }
}

async function getYoutubeVideoSuggestion(topic) {
  try {
    // Get previously suggested videos from storage
    const storageData = await chrome.storage.local.get('suggestedVideoUrls');
    const previousVideos = storageData.suggestedVideoUrls || [];
    
    const prompt = `Suggest a single educational YouTube video URL about "${topic}" that is NOT in this list: ${JSON.stringify(previousVideos)}. Only return the URL, nothing else.`;

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
      throw new Error('Failed to get video suggestion');
    }

    const data = await response.json();
    const videoUrl = data.candidates[0].content.parts[0].text.trim();
    
    // Validate the YouTube URL
    if (!isValidYoutubeUrl(videoUrl)) {
      throw new Error('Invalid YouTube URL received from Gemini');
    }
    
    // Update storage with new video URL
    previousVideos.push(videoUrl);
    await chrome.storage.local.set({ suggestedVideoUrls: previousVideos });
    
    return videoUrl;
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
    const { enabled, topic } = await chrome.storage.sync.get(['enabled', 'topic']);
    if (!enabled || !topic) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    // Inject content script to get page content
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
        return extractText(document.body).replace(/\\s+/g, ' ').trim();
      },
    });

    const analysis = await analyzeContent(content, topic);
    const currentState = {
      currentContent: content.substring(0, 100) + "...",
      contentTopic: analysis.contentTopic,
      selectedTopic: topic,
      isRelevant: analysis.isRelevant,
      timestamp: new Date().toISOString(),
      tabId: tab.id
    };

    await chrome.storage.local.set({ currentState });

    if (isRelevant) {
      // Stop the timer if content is relevant
      chrome.alarms.clear('youtubeSuggestion');
      await chrome.storage.sync.set({ timerEndTime: null });
    } else {
      // Check if we have a next video ready
      const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
      if (!nextVideoUrl) {
        // Prepare next video if we don't have one
        await prepareNextVideo(topic);
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