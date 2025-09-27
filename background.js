import { GoogleGenerativeAI } from './lib/gemini.js';

// Clean reimplementation after refactor corruption
let API_KEY = null;
let modelConfigured = false;
let isExtensionEnabled = false;
let selectedTopic = '';
let originalTimer = 0;
let isCheckingConnection = false;
let pendingCheck = null;
const comparisonCache = new Map();
const classificationCache = new Map();

const TRUSTED_CHANNEL_PATTERNS = [
  'freecodecamp','khan','coursera','google developers','microsoft developer',
  'mit opencourseware','stanford online','ibm technology','nvidia developer','tensorflow'
];

chrome.storage.sync.get(['apiKey'], r => { API_KEY = r.apiKey ? r.apiKey.trim() : null; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.apiKey) {
    API_KEY = changes.apiKey.newValue ? changes.apiKey.newValue.trim() : null;
    modelConfigured = false;
  }
});

function requireKey() { if (!API_KEY) throw new Error('Missing API key'); }
async function gem(prompt){ requireKey(); return await GoogleGenerativeAI.generateContent(API_KEY, prompt); }

function scheduleCheck(){
  if(!isExtensionEnabled) return;
  if(pendingCheck) clearTimeout(pendingCheck);
  pendingCheck = setTimeout(()=>{ pendingCheck=null; checkActiveTab(); },350);
}

async function extractStructured(tabId){
  return new Promise((res,rej)=>{
    chrome.tabs.sendMessage(tabId,{action:'extractStructuredContent'},resp=>{
      if(chrome.runtime.lastError){
        const msg = chrome.runtime.lastError.message || '';
        // Fallback: attempt to programmatically inject content.js once, then retry
        if(/Receiving end does not exist/i.test(msg)){
          try {
            chrome.scripting.executeScript({ target:{ tabId }, files:['content.js'] }, () => {
              if(chrome.runtime.lastError){ return rej(new Error('Injection failed: '+chrome.runtime.lastError.message)); }
              // Retry after injection
              chrome.tabs.sendMessage(tabId,{action:'extractStructuredContent'},r2=>{
                if(chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
                if(!r2||!r2.success) return rej(new Error(r2?.error||'Extraction failed after inject'));
                res(r2.data);
              });
            });
          } catch(e){ return rej(new Error('Injection exception: '+e.message)); }
          return; // exit early
        }
        return rej(new Error(msg));
      }
      if(!resp||!resp.success) return rej(new Error(resp?.error||'Extraction failed'));
      res(resp.data);
    });
  });
}

async function classify(urlKey, data){
  if(classificationCache.has(urlKey)) return classificationCache.get(urlKey);
  try {
    const prompt = `Classify page.
CATEGORY: <broad>
TOPIC: <specific>
AUDIENCE: <audience>
Title:${data.title}
Desc:${data.description||'N/A'}
Headers:${(data.headers.h1||[]).slice(0,3).join('; ')}
Body:${data.body.slice(0,300)}
`;
    const t = await gem(prompt);
    const category = (t.match(/CATEGORY:\s*([^\n]+)/i)||[, 'Unknown'])[1].trim();
    const topic = (t.match(/TOPIC:\s*([^\n]+)/i)||[, 'Unknown'])[1].trim();
    const audience = (t.match(/AUDIENCE:\s*([^\n]+)/i)||[, 'Unknown'])[1].trim();
    const result = { category, topic, audience };
    classificationCache.set(urlKey,result);
    return result;
  } catch { return { category:'Unknown', topic:'Unknown', audience:'Unknown' }; }
}

async function compare(pageCategory,pageTopic,userTopic){
  const key=`${pageCategory}|${pageTopic}|${userTopic}`.toLowerCase();
  if(comparisonCache.has(key)) return comparisonCache.get(key);
  try {
    const prompt = `Relation?
PAGE_CATEGORY:${pageCategory}
PAGE_TOPIC:${pageTopic}
USER_TOPIC:${userTopic}
MATCH: yes/no
CONFIDENCE: 0-100
REASON: <short>`;
    const t = await gem(prompt);
    const isRelevant = /MATCH:\s*yes/i.test(t);
    const c = t.match(/CONFIDENCE:\s*(\d{1,3})/i); const confidence = c? Math.min(100,parseInt(c[1],10))/100:0;
    const reason = (t.match(/REASON:\s*([^\n]+)/i)||[, ''])[1].trim();
    const result = { isRelevant, confidence, reason };
    comparisonCache.set(key,result);
    return result;
  } catch { return { isRelevant:false, confidence:0, reason:'Comparison failed'}; }
}

async function suggestVideo(topic){
  if(!API_KEY) return null;
  const trusted = TRUSTED_CHANNEL_PATTERNS;
  const basePrompt = (attempt)=>`Return ONLY one viable, currently accessible YouTube educational video.
Topic: ${topic}
Rules:
 - Channel must be one of (case-insensitive contains): ${trusted.join(', ')}
 - Prefer upload year >= 2023
 - MUST use canonical watch URL form: https://www.youtube.com/watch?v=VIDEOID (11 chars)
 - NO playlists (no &list=), NO shorts (/shorts/), NO youtu.be short links, NO live streams
 - If prior attempt invalid${attempt? ' (bad/unavailable/playlist/shorts)':''}, choose different channel.
Output EXACTLY:
VIDEO_URL: https://www.youtube.com/watch?v=XXXXXXXXXXX
CHANNEL: <channel name>`;

  function parseCandidate(raw){
    if(!raw) return { ok:false, reason:'empty raw'};
    const urlMatch = raw.match(/VIDEO_URL:\s*(https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11}))/i);
    if(!urlMatch) return { ok:false, reason:'no watch url'};
    const fullUrl = urlMatch[1];
    if(/(&|\?)list=|shorts\//i.test(fullUrl)) return { ok:false, reason:'playlist/shorts disallowed'};
    const chMatch = raw.match(/CHANNEL:\s*([^\n]+)/i);
    const channel = (chMatch? chMatch[1].trim(): '').toLowerCase();
    if(!channel) return { ok:false, reason:'missing channel'};
    if(!trusted.some(p=>channel.includes(p))) return { ok:false, reason:'untrusted channel'};
    return { ok:true, url: fullUrl, channel };
  }

  for(let attempt=0; attempt<3; attempt++){
    try {
      const raw = await gem(basePrompt(attempt));
      const candidate = parseCandidate(raw);
      if(candidate.ok){
        return candidate.url;
      } else {
        console.warn('[SageMode] video candidate rejected:', candidate.reason);
      }
    } catch (e) {
      console.warn('[SageMode] video suggestion attempt failed', e.message);
    }
  }
  return null; // fallback: none
}

async function checkActiveTab(){
  try {
    const { enabled, topic, isMonitoring } = await chrome.storage.sync.get(['enabled','topic','isMonitoring']);
    if(!enabled || !isMonitoring){ chrome.action.setBadgeText({ text:''}); return; }
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    if(!tab) return;
    try { const u=new URL(tab.url); if(!/^https?:/.test(u.protocol)) return; } catch { return; }
    if(!API_KEY){ chrome.action.setBadgeText({ text:'KEY'}); chrome.action.setBadgeBackgroundColor({ color:'#e67e22'}); return; }
    const data = await extractStructured(tab.id);
    if(!topic){
      // We can still populate state minimally without relevance logic
      chrome.action.setBadgeText({ text:'' });
      chrome.storage.local.set({ currentState:{ currentContent: data.title.slice(0,120), pageUrl:data.url, timestamp:new Date().toISOString(), tabId:tab.id } });
      return;
    }
    const urlKey = data.url.split('#')[0];
    const cls = await classify(urlKey,data);
    const { isRelevant, confidence, reason } = await compare(cls.category, cls.topic, topic);
    chrome.tabs.sendMessage(tab.id,{ action:'updateHighlight', color: isRelevant? '#2ecc71':'#e74c3c', reason: reason|| (isRelevant?'Relevant':'Not relevant') });
    const state = { currentContent: data.title.slice(0,120), contentTopic:`${cls.category} - ${cls.topic}\n(${cls.audience})`, selectedTopic:topic, isRelevant, confidence, reason, timestamp:new Date().toISOString(), tabId:tab.id };
    chrome.storage.local.set({ currentState: state });
    if(isRelevant && confidence>=0.6){
      chrome.action.setBadgeText({ text:'✓'}); chrome.action.setBadgeBackgroundColor({ color:'#2ecc71'});
      chrome.alarms.clear('youtubeSuggestion'); chrome.storage.sync.set({ timerEndTime:null }); chrome.storage.local.remove('nextVideoUrl');
    } else {
      chrome.action.setBadgeText({ text:'!'}); chrome.action.setBadgeBackgroundColor({ color:'#e74c3c'});
      const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
      if(!nextVideoUrl){ const vid = await suggestVideo(topic); if(vid) chrome.storage.local.set({ nextVideoUrl: vid }); }
      const { timerEndTime } = await chrome.storage.sync.get('timerEndTime');
      if(!timerEndTime){ const { timer=5 } = await chrome.storage.sync.get('timer'); chrome.alarms.create('youtubeSuggestion',{ delayInMinutes: timer }); chrome.storage.sync.set({ timerEndTime: Date.now()+timer*60*1000 }); }
    }
    chrome.runtime.sendMessage({ action:'contentStateUpdate', state:{ isRelevant, confidence, reason, pageTitle:data.title, pageUrl:data.url } });
  } catch (e) {
    console.error('Check failed', e);
    chrome.action.setBadgeText({ text:'x'}); chrome.action.setBadgeBackgroundColor({ color:'#e74c3c'});
  }
}

// Messages
chrome.runtime.onMessage.addListener((req, _sender, sendResponse)=>{
  if(req.action==='checkGeminiConnection'){
    if(!API_KEY){ sendResponse({ success:false, error:'Missing API key'}); return true; }
    if(isCheckingConnection){ sendResponse({ success: modelConfigured, error:'Check in progress'}); return true; }
    isCheckingConnection=true;
    GoogleGenerativeAI.generateContent(API_KEY,'ping').then(()=>{ modelConfigured=true; sendResponse({ success:true }); }).catch(err=>{ modelConfigured=false; sendResponse({ success:false, error: err.message }); }).finally(()=>{ isCheckingConnection=false; });
    return true;
  }
  if(req.action==='setExtensionState'){
    const prevEnabled = isExtensionEnabled;
    const prevTopic = selectedTopic;
    const prevTimer = originalTimer;
    isExtensionEnabled = req.enabled; selectedTopic = req.topic||''; originalTimer = req.timer||0; chrome.alarms.clear('contentCheck');
    if(isExtensionEnabled){
      // Only reset suggestion timer if newly enabled or core parameters changed
      if(!prevEnabled || prevTopic!==selectedTopic || prevTimer!==originalTimer){
        chrome.alarms.clear('youtubeSuggestion');
        chrome.storage.sync.set({ timerEndTime: null });
      }
      if(API_KEY && !modelConfigured){
        GoogleGenerativeAI.generateContent(API_KEY,'ping').then(()=>{ modelConfigured=true; }).catch(()=>{ modelConfigured=false; chrome.action.setBadgeText({ text:'KEY'}); chrome.action.setBadgeBackgroundColor({ color:'#e67e22'}); });
      } else if(!API_KEY){
        chrome.action.setBadgeText({ text:'KEY'}); chrome.action.setBadgeBackgroundColor({ color:'#e67e22'});
      }
      scheduleCheck();
    } else {
      chrome.action.setBadgeText({ text:'' });
      chrome.alarms.clear('youtubeSuggestion');
      chrome.storage.sync.set({ timerEndTime: null });
    }
    sendResponse({ success:true }); return true; }
  if(req.action==='checkContent'){
    scheduleCheck(); sendResponse({ success:true }); return true; }
});

// Events
chrome.tabs.onUpdated.addListener((_id, changeInfo)=>{ if(changeInfo.status==='complete') scheduleCheck(); });
chrome.tabs.onActivated.addListener(()=> scheduleCheck());
chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name==='youtubeSuggestion'){
    const { nextVideoUrl } = await chrome.storage.local.get('nextVideoUrl');
    const { enabled, topic } = await chrome.storage.sync.get(['enabled','topic']);
    if(enabled && topic && nextVideoUrl){
      const [currentTab] = await chrome.tabs.query({ active:true, currentWindow:true });
      await chrome.tabs.create({ url: nextVideoUrl });
      if(currentTab) chrome.tabs.remove(currentTab.id).catch(()=>{});
      chrome.storage.local.remove('nextVideoUrl');
      chrome.storage.sync.remove('timerEndTime');
    }
  }
});

chrome.runtime.onInstalled.addListener(()=>{
  chrome.storage.sync.get(['enabled','timer'], r=>{
    if(r.enabled===undefined) chrome.storage.sync.set({ enabled:false });
    if(r.timer===undefined) chrome.storage.sync.set({ timer:5 });
  });
});

// Periodic timer broadcast so popup opened mid-cycle can show without waiting for local poll
setInterval(async () => {
  try {
    const { timerEndTime } = await chrome.storage.sync.get('timerEndTime');
    if(timerEndTime){
      chrome.runtime.sendMessage({ action:'timerUpdate', timerEndTime });
    }
  } catch { /* ignore */ }
}, 15000); // every 15s

export {}; // MV3 module terminator
