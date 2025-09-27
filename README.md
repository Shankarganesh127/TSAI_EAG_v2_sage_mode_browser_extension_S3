# Sage Mode Extension

This browser extension uses the Gemini AI to suggest YouTube videos based on a topic and a timer.

## Features

*   **Enable/Disable:** Toggle the Gemini AI connection.
*   **Timer:** Set a timer in minutes.
*   **Topic:** Provide a keyword for video suggestions.
*   **Save Settings:** Saves your configuration and starts the timer.

## How to Install

1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Enable "Developer mode" in the top right corner.
3.  Click "Load unpacked".
4.  Select the `sage_browser_plugin` directory.

## How to Use

1.  Click on the extension icon in your browser.
2.  Enter your Gemini API key.
3.  Enable the extension using the toggle switch.
4.  Set the timer in minutes.
5.  Enter a topic keyword.
6.  Click "Save Settings".

After the specified time, a new tab will open with a YouTube video related to your topic.

## Local Gemini Connectivity Test

You can verify your API key works outside the extension before testing in Chrome.

JavaScript (Node):

```powershell
# PowerShell
Set-Location path\to\sage_browser_plugin
$env:GEMINI_API_KEY="your-key-here"; node test_gemini.js
```

Python:

```powershell
# PowerShell
Set-Location path\to\sage_browser_plugin
$env:GEMINI_API_KEY="your-key-here"; python test_gemini.py
```

Success Criteria:
* JS script prints: "🎉 Success! Gemini connectivity verified." or at least returns model text.
* Python script returns a candidate with your expected echo text.

If you get 401/403:
* Confirm the key is from Google AI Studio with the Generative Language API enabled.
If you get 404:
* The primary model may be unavailable; the JS client rotates through fallbacks.
If you get 429:
* You hit quota; wait and retry (the client already retries with backoff).

## Security Note

Never commit your API key. The test scripts read from the GEMINI_API_KEY environment variable; they do not store it.
