import { GoogleGenerativeAI } from './lib/gemini.js';

const GEMINI_API_KEY = 'AIzaSyBe4P7dmOiBy6gE9Yys4kk0CHf8r04EC0Q';
let modelConfigured = false;
let suggestedVideos = new Set(); // Store suggested video URLs
let lastRequestTime = 0; // Track the last API request time

// Initialize Gemini API connection
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkGeminiConnection') {
    console.log('🔄 Checking Gemini API connection...');
    
    // Use the Gemini SDK to test connection
    GoogleGenerativeAI.generateContent(GEMINI_API_KEY, 'test')
      .then(async () => {
        modelConfigured = true;
        console.log('✅ Connected to Gemini API');
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('❌ API connection failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;  // Will respond asynchronously
  }
});

async function getYouTubeVideoSuggestion(topic) {
  try {
    console.log('🎥 Getting video suggestion for topic:', topic);

    const prompt = `Suggest an educational YouTube video about "${topic}".
Consider:
1. Video should be from a reputable source
2. Content should be educational and informative
3. Should be suitable for learning about the topic
4. Prefer recent, high-quality content

Format your response EXACTLY like this, including the labels:
VIDEO_TITLE: [title]
VIDEO_URL: [full YouTube URL starting with https://]
REASON: [why this video is relevant]

IMPORTANT: The URL must be a complete, valid YouTube URL starting with https://`;

    console.log('🎥 Requesting video with prompt:', prompt);
    const response = await GoogleGenerativeAI.generateContent(GEMINI_API_KEY, prompt);
    console.log('Raw video suggestion response:', response);
    
    const urlMatch = response.match(/VIDEO_URL:\s*(https:\/\/(?:www\.)?youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)?[a-zA-Z0-9_-]+(?:\S+)?)/i);
    
    if (!urlMatch) {
      console.error('No valid YouTube URL found in response:', response);
      throw new Error('No valid YouTube URL found in response');
    }

    // Clean up the URL to ensure it's in the correct format
    let videoUrl = urlMatch[1].trim();
    if (!videoUrl.includes('watch?v=')) {
      const videoId = videoUrl.split('/').pop().split('?')[0];
      videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    }

    console.log('📺 Extracted video URL:', videoUrl);
    return videoUrl;
  } catch (error) {
    console.error('❌ Error getting video suggestion:', error);
    return null;
  }
}

async function compareTopics(pageCategory, pageTopic, selectedTopic) {
  try {
    const comparePrompt = `Compare these topics:

Page Category: ${pageCategory}
Page Topic: ${pageTopic}
User's Selected Topic: ${selectedTopic}

Consider:
1. Direct matches (same topic/category)
2. Related topics within same category
3. Subtopics or broader topics that encompass each other
4. Semantic similarity and relevance

Response format:
MATCH: [yes/no]
CONFIDENCE: [0-100]
REASON: [brief explanation]`;
    
    console.log('Comparing topics with prompt:', comparePrompt);
    const result = await GoogleGenerativeAI.generateContent(GEMINI_API_KEY, comparePrompt);
    console.log('Raw comparison result:', result);
    
    const matchMatch = result.match(/MATCH:\s*(yes|no)/i);
    const confidenceMatch = result.match(/CONFIDENCE:\s*(\d+)/i);
    const reasonMatch = result.match(/REASON:\s*([^\n]+)/i);

    if (!matchMatch || !confidenceMatch) {
      console.error('Invalid format in result:', result);
      throw new Error('Invalid comparison result format');
    }

    const isRelevant = matchMatch[1].toLowerCase() === 'yes';
    const confidence = parseInt(confidenceMatch[1], 10) / 100;
    const reason = reasonMatch ? reasonMatch[1].trim() : '';

    console.log('🎯 Topic comparison result:', { isRelevant, confidence, reason });
    return { isRelevant, confidence, reason };
  } catch (error) {
    console.error('❌ Topic comparison error:', error);
    return { isRelevant: false, confidence: 0, reason: 'Error comparing topics' };
  }
}

async function checkActiveTabContent() {
  try {
    console.log('🔄 Starting Active Tab Content Check');
    
    // Implement rate limiting
    const now = Date.now();
    if (now - lastRequestTime < 1000) {
      console.log('⏳ Rate limiting: Waiting for 1-second cooldown...');
      return;
    }
    
    const { enabled, topic, isMonitoring } = await chrome.storage.sync.get(['enabled', 'topic', 'isMonitoring']);
    if (!enabled || !topic || !isMonitoring) {
      console.log('⏸️ Extension state:', { enabled, topic, isMonitoring });
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    
    // Update last request time
    lastRequestTime = now;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.log('⚠️ No active tab found');
      await chrome.action.setBadgeText({ text: '?' });
      await chrome.action.setBadgeBackgroundColor({ color: '#95a5a6' });
      return;
    }

    // Handle restricted URLs
    try {
      const url = new URL(tab.url);
      const restrictedProtocols = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'file:', 'chrome-search:'];
      if (restrictedProtocols.some(protocol => url.protocol.startsWith(protocol))) {
        console.log('⏭️ Skipping restricted page:', url.protocol);
        await chrome.action.setBadgeText({ text: '-' });
        await chrome.action.setBadgeBackgroundColor({ color: '#95a5a6' });
        return;
      }
    } catch (error) {
      console.log('⚠️ Invalid or restricted URL');
      await chrome.action.setBadgeText({ text: '-' });
      await chrome.action.setBadgeBackgroundColor({ color: '#95a5a6' });
      return;
    }

    // Extract page content
    try {
      const content = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          const getMetaContent = (name) => {
            const meta = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
            return meta ? meta.getAttribute('content') : '';
          };

          // Extract meaningful content
          const extractText = (node) => {
            if (!node) return '';
            if (node.nodeType === Node.TEXT_NODE) return node.textContent;
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'NAV', 'FOOTER'].includes(node.tagName)) return '';
            
            // Special handling for headers
            if (['H1', 'H2', 'H3'].includes(node.tagName)) {
              return `[${node.tagName}] ${node.textContent.trim()} [/${node.tagName}]\n`;
            }
            
            return Array.from(node.childNodes).map(extractText).join(' ');
          };

          // Get all headers first
          const h1s = Array.from(document.querySelectorAll('h1')).map(h => `[H1] ${h.textContent.trim()} [/H1]`);
          const h2s = Array.from(document.querySelectorAll('h2')).map(h => `[H2] ${h.textContent.trim()} [/H2]`);
          const h3s = Array.from(document.querySelectorAll('h3')).map(h => `[H3] ${h.textContent.trim()} [/H3]`);
          
          // Get main content
          const mainContent = document.querySelector('main') || document.querySelector('article') || document.body;
          const bodyText = extractText(mainContent).replace(/\s+/g, ' ').trim();
          
          // Get metadata
          const description = getMetaContent('description') || getMetaContent('og:description');
          const keywords = getMetaContent('keywords');
          const title = document.title;

          // Combine all content with clear section markers
          return `
PAGE TITLE: ${title}

HEADERS HIERARCHY:
${h1s.join('\n')}
${h2s.join('\n')}
${h3s.join('\n')}

META DESCRIPTION:
${description}

KEYWORDS:
${keywords}

MAIN CONTENT:
${bodyText}
`.trim();
        }
      });

      if (!content || !content[0]?.result) {
        throw new Error('No content found on page');
      }

      const pageText = content[0].result;
      if (!pageText.trim()) {
        throw new Error('Empty page content');
      }

      console.log('📝 Retrieved page content:', pageText.slice(0, 100) + '...');

      // Extract page topic from Gemini response
      const topicPrompt = `Based on this webpage content, determine:
1. The main topic category
2. The specific subject matter
3. The target audience and content level

Format your response exactly like this:
CATEGORY: [Main category like Technology, Science, Business, etc.]
TOPIC: [Specific subject matter]
AUDIENCE: [Target audience and level]

Content to analyze:
${pageText.substring(0, 1500)}...`;

      const topicAnalysis = await GoogleGenerativeAI.generateContent(GEMINI_API_KEY, topicPrompt);
      
      // Extract category and topic
      const categoryMatch = topicAnalysis.match(/CATEGORY:\s*([^\n]+)/);
      const topicMatch = topicAnalysis.match(/TOPIC:\s*([^\n]+)/);
      const audienceMatch = topicAnalysis.match(/AUDIENCE:\s*([^\n]+)/);

      const pageCategory = categoryMatch ? categoryMatch[1].trim() : 'Unknown';
      const pageTopic = topicMatch ? topicMatch[1].trim() : 'Unknown';
      const pageAudience = audienceMatch ? audienceMatch[1].trim() : 'Unknown';

      // Compare topics using the new comparison function
      const { isRelevant, confidence, reason } = await compareTopics(pageCategory, pageTopic, topic);

      // Save current state for UI
      const currentState = {
        currentContent: pageText.substring(0, 100) + "...",
        contentTopic: `${pageCategory} - ${pageTopic}\n(${pageAudience})`,
        selectedTopic: topic,
        isRelevant,
        confidence,
        reason,
        timestamp: new Date().toISOString(),
        tabId: tab.id
      };

      console.log('💾 Saving Current State:', currentState);
      await chrome.storage.local.set({ currentState });

      if (isRelevant && confidence >= 0.7) {
        console.log('✅ Content is relevant to topic');
        await chrome.action.setBadgeText({ text: '✓' });
        await chrome.action.setBadgeBackgroundColor({ color: '#2ecc71' });
        
        // Clear any existing timer and video suggestion
        chrome.alarms.clear('youtubeSuggestion');
        await chrome.storage.sync.set({ timerEndTime: null });
        await chrome.storage.local.remove('nextVideoUrl');
      } else {
        console.log('⚠️ Content not relevant, preparing video suggestion');
        await chrome.action.setBadgeText({ text: '!' });
        await chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });

        // Get a video suggestion if we don't have one
        const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
        if (!nextVideoUrl) {
          const videoUrl = await getYouTubeVideoSuggestion(topic);
          if (videoUrl) {
            await chrome.storage.local.set({ nextVideoUrl: videoUrl });
          }
        }

        // Start/update timer if not already running
        const { timerEndTime } = await chrome.storage.sync.get('timerEndTime');
        if (!timerEndTime) {
          const { timer = 5 } = await chrome.storage.sync.get('timer');
          chrome.alarms.create('youtubeSuggestion', { delayInMinutes: timer });
          await chrome.storage.sync.set({ timerEndTime: Date.now() + timer * 60 * 1000 });
        }
      }

      // Broadcast state update
      chrome.runtime.sendMessage({ 
        action: 'contentStateUpdate', 
        state: { 
          isRelevant, 
          confidence,
          reason,
          pageTitle: tab.title,
          pageUrl: tab.url
        }
      });

    } catch (error) {
      console.error('❌ Error processing page:', error);
      await chrome.action.setBadgeText({ text: 'x' });
      await chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
    }
  } catch (error) {
    console.error('❌ Error checking active tab content:', error);
  }
}

// Set up tab-based monitoring
function startMonitoring() {
  // Only check on tab changes now, no interval needed
  checkActiveTabContent();
}

function stopMonitoring() {
  // No need to clear anything since we're not using intervals
  console.log('Monitoring stopped');
}

// Initialize when the extension loads
chrome.runtime.onInstalled.addListener(() => {
  console.log('🚀 Extension installed/updated');
  chrome.storage.sync.get(['enabled', 'topic', 'timer'], (result) => {
    if (result.enabled === undefined) {
      chrome.storage.sync.set({ enabled: false });
    }
    if (result.timer === undefined) {
      chrome.storage.sync.set({ timer: 5 }); // Default 5 minutes
    }
  });
});

// Listen for changes in monitoring state
chrome.storage.onChanged.addListener((changes) => {
  if (changes.isMonitoring) {
    if (changes.isMonitoring.newValue) {
      startMonitoring();
    } else {
      stopMonitoring();
    }
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    checkActiveTabContent();
  }
});

// Listen for tab activation
chrome.tabs.onActivated.addListener(() => {
  checkActiveTabContent();
});

// Listen for alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'youtubeSuggestion') {
    const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
    const { enabled, topic } = await chrome.storage.sync.get(['enabled', 'topic']);
    
    if (enabled && topic && nextVideoUrl) {
      try {
        console.log('🔄 Processing alarm for video suggestion...');
        
        // Get the current tab
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!currentTab) {
          throw new Error('No active tab found');
        }
        
        console.log('📑 Current tab:', currentTab.id, currentTab.url);
        
        // Create new tab with video
        console.log('🎥 Opening video URL:', nextVideoUrl);
        const newTab = await chrome.tabs.create({ url: nextVideoUrl });
        console.log('✅ New tab created:', newTab.id);
        
        // Short delay to ensure new tab is properly opened
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Close the previous tab
        console.log('🔚 Closing previous tab:', currentTab.id);
        await chrome.tabs.remove(currentTab.id);
        
        // Clear stored data
        await chrome.storage.local.remove('nextVideoUrl');
        await chrome.storage.sync.remove('timerEndTime');
        console.log('🧹 Cleared stored video URL and timer');
        
      } catch (error) {
        console.error('❌ Error in alarm handler:', error);
      }
    } else {
      console.log('⚠️ Alarm triggered but conditions not met:', { enabled, topic, hasUrl: !!nextVideoUrl });
    }
  }
});