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

      if (currentState) {
        contentText.textContent = currentState.currentContent;
        matchDot.className = `match-dot ${currentState.isRelevant ? 'matched' : 'not-matched'}`;
        matchText.textContent = currentState.isRelevant ? 'Content matches topic' : 'Content does not match topic';
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

    chrome.runtime.sendMessage({ action: 'checkConnection' }, (response) => {
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
      if (result.timerEndTime && result.timerEndTime > Date.now()) {
        const remaining = Math.round((result.timerEndTime - Date.now()) / 1000);
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        timerDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      } else {
        timerDisplay.textContent = '00:00';
        if (timerInterval) {
          clearInterval(timerInterval);
        }
      }
    });
  }

  // Load saved settings
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

  saveButton.addEventListener('click', () => {
    const enabled = enabledCheckbox.checked;
    const timer = parseInt(timerInput.value, 10);
    const topic = topicInput.value;

    if (enabled) {
      const timerEndTime = Date.now() + timer * 60 * 1000;
      chrome.storage.sync.set({ enabled, timer, topic, timerEndTime }, () => {
        console.log('Settings saved and timer started');
        chrome.alarms.create('youtubeSuggestion', { delayInMinutes: timer });
        updateTimerDisplay();
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(updateTimerDisplay, 1000);
        window.close();
      });
    } else {
      chrome.storage.sync.set({ enabled, timer, topic, timerEndTime: null }, () => {
        console.log('Settings saved and timer cleared');
        chrome.alarms.clear('youtubeSuggestion');
        if (timerInterval) clearInterval(timerInterval);
        timerDisplay.textContent = '00:00';
        window.close();
      });
    }
  });
});
