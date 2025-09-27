<div align="center">

# 🔍 Sage Mode – Focus & Assisted Learning Extension

Stay on–topic while browsing. If you drift away from your chosen study topic, a timer counts down and then opens a (model‑suggested) YouTube video to bring you back to learning.

</div>

## ✨ Core Idea
1. You specify a learning topic (e.g. "Rust ownership", "React performance", "Data Structures").
2. The extension continuously (every ~5s) classifies the current tab’s content.
3. If the page is relevant → badge shows ✓ and no intervention happens.
4. If the page is NOT relevant → a countdown timer starts (or continues) toward a focus reminder.
5. When the timer expires, a YouTube tab opens with a suggested educational video for your topic.

## ✅ Key Features
- **Real‑time Monitoring:** Lightweight content extraction + model comparison + heuristic keyword coverage.
- **Heuristic Boost:** If the page title/headers already cover most topic keywords, it’s marked relevant immediately (saves API calls).
- **Configurable Topic & Timer:** Choose what you want to learn and how long until a redirect suggestion.
- **Per‑Second Timer Broadcast:** Timer updates (remaining milliseconds) are emitted for precise UI display.
- **5s Re‑Check Loop:** Ensures classification stays current even on dynamic/SPAs.
- **SPA Awareness:** Re-check after navigation + a delayed second pass after load (hydration window).
- **AI Video Suggestion:** (Simplified mode) Extracts the first YouTube URL returned by Gemini and canonicalizes it.
- **Fail‑Safe Abort:** If the page becomes relevant right before opening a video, the redirect is cancelled.

## 🗂 Project Structure (High Level)
| File | Purpose |
|------|---------|
| `background.js` | Core logic: extraction, classification, comparison, timer, suggestion, tab handling |
| `lib/gemini.js` | Gemini API wrapper, model selection & generation helpers |
| `popup.*` | UI for enabling, entering API key, setting topic & timer |
| `options.*` | API key management & diagnostics |
| `manifest.json` | Chrome extension manifest (MV3) |

> Note: Only key logic files are shown. Some helper files (content scripts, etc.) manage DOM extraction.

## 🧠 Relevance Decision Flow
1. Extract structured page data (title, description, headers, snippet of body).
2. Heuristic keyword coverage: if ≥70% of topic tokens appear → mark relevant.
3. Otherwise, classify the page (broad category + specific topic + audience).
4. Compare page topic vs selected topic with a model prompt (synonym/sub-topic aware).
5. If confidence ≥ 0.6 and relevant → clear timer; else schedule/continue timer.

## ⏱ Timer Mechanics
| Aspect | Behavior |
|--------|----------|
| Start | When page is judged not relevant and no active suggestion countdown exists |
| Storage Fields | `timerEndTime`, `timerStartedAt`, `timerDurationMs` (sync storage) |
| Updates | `timerTick` message every 1s with `{now, timerEndTime, remainingMs}` |
| Cancel | Page becomes relevant OR extension disabled OR topic changed |
| Fire | Chrome alarm (`youtubeSuggestion`) opens YouTube tab |

## ▶️ Video Suggestion (Simplified Mode)
Current implementation intentionally minimal per user request:
1. Prompt Gemini: “Provide ONE YouTube video URL helpful for topic: X. Only output the URL.”
2. Extract first YouTube or youtu.be link via regex.
3. Canonicalize to `https://www.youtube.com/watch?v=VIDEOID` (strip extras, normalize short links).
4. Retry with a stricter prompt if first attempt fails.

> Previous stricter validation (oEmbed availability, channel whitelist, title relevance) was removed for simplicity. Re‑introduce selectively if too many dead links appear.

## 🚀 Installation (Developer Mode)
1. Open `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `sage_browser_plugin` folder.
5. The extension icon should appear in the toolbar.

## 🛠 First-Time Setup
1. Click the extension icon (popup opens).
2. Enter your Gemini API key (from Google AI Studio).
3. Toggle **Enable**.
4. Enter your **Learning Topic**.
5. Set the **Timer (minutes)**.
6. Save. Monitoring begins; badge shows ✓ or !.

## 🔄 Popup / Badge States
| Badge | Meaning |
|-------|---------|
| (blank) | Disabled or not monitoring |
| `KEY` | Missing / invalid API key (configure in options) |
| `✓` | Current tab is relevant to topic |
| `!` | Current tab is off-topic; timer running |
| `x` | Last classification attempt failed |

## 🧪 Optional: Test Gemini API Locally
You can verify connectivity before using the extension.

PowerShell (Node):
```powershell
Set-Location path\to\sage_browser_plugin
$env:GEMINI_API_KEY="your-key-here"; node test_gemini.js
```

PowerShell (Python):
```powershell
Set-Location path\to\sage_browser_plugin
$env:GEMINI_API_KEY="your-key-here"; python test_gemini.py
```

Common Errors:
| Status | Likely Cause | Action |
|--------|--------------|--------|
| 401/403 | Invalid / unauthorized key | Regenerate or enable Generative Language API |
| 404 | Requested model not available | Fallback or adjust model list |
| 429 | Rate limit / quota | Wait & retry |

## 🧩 Heuristic Keyword Coverage
The heuristic relevance layer tokenizes both the topic and page (title + description + top headers), ignoring common stopwords. If ≥70% of topic tokens appear, the page is treated as relevant without waiting for model comparison. This reduces latency & API usage.

## 🔐 Security
- API key stored in Chrome sync storage (user scope) – not committed.
- Never paste your key into shared screenshots.
- Test scripts read from the environment; they don’t persist secrets.

## 🕵️ Debugging Tips
| What | How |
|------|-----|
| Current state | Check `chrome.storage.local.get('currentState')` in DevTools console |
| Next video URL | `chrome.storage.local.get('nextVideoUrl')` |
| Timer info | `chrome.storage.sync.get(['timerEndTime','timerStartedAt','timerDurationMs'])` |
| Suggestion debug log | `chrome.storage.local.get('suggestionDebug')` |

## ♻️ Resetting State Quickly
Open DevTools (background page) and run:
```js
chrome.storage.sync.clear(); chrome.storage.local.clear();
```
Then reload the extension.

## 🔄 Future / Optional Enhancements (Not Currently Enabled)
- Channel whitelisting & educational source scoring
- Video availability validation (oEmbed / noembed dual check)
- Duplicate rejection persistence across sessions
- “Strict vs Simple” suggestion mode toggle
- Popup countdown display (consuming `timerTick`)

## ⚠️ Known Trade‑Offs (Simplified Mode)
| Removed Check | Consequence |
|---------------|-------------|
| Availability (oEmbed) | Might open private / removed videos |
| Channel filtering | Could surface non-educational content |
| Title/topic validation | Looser topical match in suggestions |

Re-enable pieces incrementally if precision matters more than simplicity.

## 📝 Changelog Highlights (Recent)
- Added heuristic keyword coverage relevance.
- Added per-second timer ticks with remainingMs.
- Added 5s monitoring re-check loop.
- Added SPA delayed re-check (2.5s).
- Simplified video suggestion to regex-based first link extraction (per request).

## ❓ FAQ
**Q:** Video opened but isn’t available.  
**A:** In simplified mode there’s no availability check. Switch back to strict logic if this becomes frequent.

**Q:** Timer didn’t fire.  
**A:** Page likely became relevant (timer cleared). Check storage for `timerEndTime`.

**Q:** High API usage?  
**A:** Heuristic path should reduce calls; consider increasing the 5s interval if needed.

## 🤝 Contributing
1. Fork & create a feature branch.
2. Keep changes minimal & cohesive.
3. Add a short note to a future CHANGELOG section if expanding functionality.

## 📄 License
Internal / Educational use. Add a LICENSE file if distributing.

---
**Enjoy focused learning!** If you want a stricter or smarter video selection mode again, open an issue or request a toggle implementation.
