document.addEventListener('DOMContentLoaded', () => {
  const enabledCheckbox = document.getElementById('enabled');
  const timerInput = document.getElementById('timer');
  const topicInput = document.getElementById('topic');
  const saveButton = document.getElementById('save');
  const timerDisplay = document.getElementById('timer-display');
  const statusDot = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const videoSuggestion = document.getElementById('video-suggestion');
  const videoLink = document.getElementById('video-link');
  let timerInterval;

  // Check for existing video suggestion and current state
  chrome.storage.sync.get(['lastVideoUrl'], (result) => {
    if (result.lastVideoUrl) {
      videoLink.href = result.lastVideoUrl;
      videoSuggestion.style.display = 'block';
    }
  });

  function updateContentStatus() {
    chrome.storage.local.get('currentState', (result) => {
      const currentState = result.currentState;
      const contentText = document.getElementById('current-content');
      const matchDot = document.querySelector('.match-dot');
      const matchText = document.querySelector('.match-text');
      const selectedTopicElement = document.getElementById('selected-topic');
      const contentTopicElement = document.getElementById('content-topic');

      if (currentState) {
        contentText.textContent = currentState.currentContent;
        selectedTopicElement.textContent = currentState.selectedTopic || 'None';
        contentTopicElement.textContent = currentState.contentTopic || 'Analyzing...';
        
        matchDot.className = `match-dot ${currentState.isRelevant ? 'matched' : 'not-matched'}`;
        matchText.textContent = currentState.isRelevant ? 'Topics match' : 'Topics do not match';
        matchText.style.color = currentState.isRelevant ? '#2ecc71' : '#e74c3c';
      }
    });
  }

  // Update content status every 5 seconds
  updateContentStatus();
  setInterval(updateContentStatus, 5000);

  // Check Gemini API connection with timeout and retry
  function checkConnection(retryCount = 0) {
    const connectionTimeout = setTimeout(() => {
      if (retryCount < 2) {
        console.log(`Connection timeout, retrying (${retryCount + 1}/2)...`);
        checkConnection(retryCount + 1);
      } else {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Connection Timeout';
        statusText.style.color = '#e74c3c';
      }
    }, 5000); // 5 second timeout

    chrome.runtime.sendMessage({ action: 'checkGeminiConnection' }, (response) => {
      clearTimeout(connectionTimeout);
      if (chrome.runtime.lastError) {
        console.error('Runtime error:', chrome.runtime.lastError);
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Extension Error';
        statusText.style.color = '#e74c3c';
        return;
      }
      
      if (response && response.success) {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Connected to Gemini';
        statusText.style.color = '#2ecc71';
      } else {
        statusDot.className = 'status-dot error';
        statusText.textContent = response?.error || 'Connection Error';
        statusText.style.color = '#e74c3c';
      }
    });
  }

  // Start the initial connection check
  checkConnection();

  function updateTimerDisplay() {
    chrome.storage.sync.get(['timerEndTime'], (result) => {
      const end = result.timerEndTime;
      if (end && typeof end === 'number') {
        const diffMs = end - Date.now();
        if (diffMs > 0) {
          const remaining = Math.floor(diffMs / 1000);
          const minutes = Math.floor(remaining / 60);
          const seconds = remaining % 60;
          timerDisplay.textContent = `${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
          return;
        }
      }
      timerDisplay.textContent = '00:00';
      if (timerInterval) clearInterval(timerInterval);
    });
  }

  // Load saved settings
  function loadSettings() {
    chrome.storage.sync.get(['enabled', 'timer', 'topic', 'apiKey'], (settings) => {
      enabledCheckbox.checked = settings.enabled || false;
      timerInput.value = settings.timer || 5;
      topicInput.value = settings.topic || '';
      
      // Update extension state in background
      updateExtensionState(settings.enabled, settings.topic, settings.timer);
      if(settings.apiKey) {
        checkConnection();
      } else {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Set API Key (API Settings)';
        statusText.style.color = '#e67e22';
      }
    });
  }

  // Update extension state in background script
  function updateExtensionState(enabled, topic, timer) {
    chrome.runtime.sendMessage({
      action: 'setExtensionState',
      enabled: enabled,
      topic: topic,
      timer: parseInt(timer)
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error updating extension state:', chrome.runtime.lastError);
      } else if (response && response.success) {
        console.log('Extension state updated successfully');
      }
    });
  }

  // Save settings with extension state update
  saveButton.addEventListener('click', () => {
    const enabled = enabledCheckbox.checked;
    const timer = parseInt(timerInput.value,10);
    const topic = topicInput.value.trim();
    if (!topic && enabled) {
      alert('Please enter a topic before enabling the extension.');
      enabledCheckbox.checked = false;
      return;
    }
    // Do NOT start timer yet; background starts when off-topic detected
    chrome.storage.sync.set({ enabled, timer, topic, timerEndTime: null, isMonitoring: enabled }, () => {
      updateExtensionState(enabled, topic, timer);
      if(enabled){
        if(timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(updateTimerDisplay,1000);
        checkConnection();
        chrome.runtime.sendMessage({ action: 'checkContent' });
      } else {
        if(timerInterval) { clearInterval(timerInterval); timerInterval=null; }
        timerDisplay.textContent='00:00';
        chrome.alarms.clear('youtubeSuggestion');
      }
      window.close();
    });
  });

  // Handle checkbox state change
  enabledCheckbox.addEventListener('change', () => {
    if (enabledCheckbox.checked && !topicInput.value.trim()) {
      alert('Please enter a topic before enabling the extension.');
      enabledCheckbox.checked = false;
      return;
    }
    updateExtensionState(enabledCheckbox.checked, topicInput.value.trim(), parseInt(timerInput.value));
    if(enabledCheckbox.checked){
      chrome.runtime.sendMessage({ action:'checkContent' });
    }
  });

  // Initial load
  loadSettings();
  chrome.storage.sync.get(['enabled', 'timer', 'topic'], (result) => {
    if (result.enabled) {
      enabledCheckbox.checked = result.enabled;
    }
    if (result.timer) {
      timerInput.value = result.timer;
    }
    if (result.topic) {
      topicInput.value = result.topic;
    }
  });

  // Initial timer display update and start interval
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);

  // Listen for content state updates
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'contentStateUpdate') {
      updateContentStatus(message.state);
    }
  });

  // Removed duplicate saveButton listener (merged above)
});
