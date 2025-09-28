import { GoogleGenerativeAI } from './lib/gemini.js';

// --- State ---------------------------------------------------------------
let API_KEY = null;
let modelConfigured = false;
let isExtensionEnabled = false;
let selectedTopic = '';
let originalTimer = 0;
let isCheckingConnection = false;
let pendingCheck = null;
let lastCheckedUrl = null; // For SPA change detection
let spaUrlPollInterval = null;
let timerTickInterval = null;
let monitorInterval = null; // 5-second re-check loop
let lastOffTopicTabId = null; // Track most recent off-topic tab to close when a relevant tab appears
// Caches (single instances)
const comparisonCache = new Map();
const classificationCache = new Map();
const rejectedVideoIds = new Set(); // persistent in-session to avoid repeating bad/unavailable videos

// --- Heuristic relevance utilities (title/content keyword coverage) -----------------
const HEURISTIC_STOP_WORDS = new Set(['the','a','an','and','for','with','of','to','on','in','by','from','about','how','learn','guide','tutorial','course','introduction','intro','this','that','into','using','use']);
function tokenizeContent(str){
	return (str||'')
		.toLowerCase()
		.replace(/[^a-z0-9+.# ]+/g,' ')
		.split(/\s+/)
		.filter(w=>w.length>2 && !HEURISTIC_STOP_WORDS.has(w));
}
function heuristicRelevance(userTopic, data){
	if(!userTopic || !data) return {decided:false};
	// Disable heuristic short-circuit on YouTube watch pages to avoid false positives caused by large recommendation text surface
	try { if(/https?:\/\/([a-zA-Z0-9-]+\.)?youtube\.com\/watch/.test(data.url)) return {decided:false}; } catch{}
	const topicTokens = tokenizeContent(userTopic);
	if(!topicTokens.length) return {decided:false};
	// Aggregate page textual surface: title + description + top headers
	const headerSlice = [
		...(data.headers?.h1||[]).slice(0,3),
		...(data.headers?.h2||[]).slice(0,3)
	].join(' ');
	const surface = `${data.title||''} ${data.description||''} ${headerSlice}`;
	const surfaceTokens = new Set(tokenizeContent(surface));
	if(!surfaceTokens.size) return {decided:false};
	let covered=0; for(const t of topicTokens){ if(surfaceTokens.has(t)) covered++; }
	const coverage = covered / topicTokens.length;
	// Strong accept if all tokens present
	if(coverage === 1){
		return {decided:true,isRelevant:true,confidence:0.95,reason:'Title/content contain all topic keywords'};
	}
	// Accept if majority of tokens (>=70%) present
	if(coverage >= 0.7){
		return {decided:true,isRelevant:true,confidence:0.85 + 0.1*(coverage-0.7)/0.3,reason:`High keyword coverage ${(coverage*100).toFixed(0)}%`};
	}
	// Early skip if almost none (<15%) to save an API call? We choose NOT to early reject to avoid false negatives.
	return {decided:false};
}

function startTimerTick(){
	if(timerTickInterval) return;
	timerTickInterval=setInterval(async()=>{
		const {timerEndTime}=await chrome.storage.sync.get('timerEndTime');
		if(!timerEndTime){ clearInterval(timerTickInterval); timerTickInterval=null; return; }
		const now=Date.now();
		chrome.runtime.sendMessage({action:'timerTick',now,timerEndTime,remainingMs:Math.max(0,timerEndTime-now)});
	},1000);
}

// Start 5s monitoring loop
function startMonitorLoop(){
	if(monitorInterval) return;
	monitorInterval=setInterval(async()=>{
		try {
			const {enabled,isMonitoring}=await chrome.storage.sync.get(['enabled','isMonitoring']);
			if(!enabled||!isMonitoring){ return; }
			scheduleCheck();
		}catch(e){ /* silent */ }
	},5000);
}
function stopMonitorLoop(){ if(monitorInterval){ clearInterval(monitorInterval); monitorInterval=null; } }

console.log('[SageMode] background script loaded');
const TRUSTED_CHANNEL_PATTERNS=[ 'freecodecamp','khan','coursera','google developers','microsoft developer','mit opencourseware','stanford online','ibm technology','nvidia developer','tensorflow' ];

chrome.storage.sync.get(['apiKey'], r=>{ API_KEY=r.apiKey? r.apiKey.trim():null; });
chrome.storage.onChanged.addListener((c,a)=>{ if(a==='sync'&&c.apiKey){ API_KEY=c.apiKey.newValue? c.apiKey.newValue.trim():null; modelConfigured=false; }});

function requireKey(){ if(!API_KEY) throw new Error('Missing API key'); }
async function gem(p){ requireKey(); return await GoogleGenerativeAI.generateContent(API_KEY,p); }

function scheduleCheck(){ if(!isExtensionEnabled) return; if(pendingCheck) clearTimeout(pendingCheck); pendingCheck=setTimeout(()=>{ pendingCheck=null; checkActiveTab(); },350); }

async function extractStructured(tabId){
	return new Promise((res,rej)=>{
		chrome.tabs.sendMessage(tabId,{action:'extractStructuredContent'},resp=>{
			if(chrome.runtime.lastError){
				const msg=chrome.runtime.lastError.message||'';
				if(/Receiving end does not exist/i.test(msg)){
					try {
						chrome.scripting.executeScript({target:{tabId},files:['content.js']},()=>{
							if(chrome.runtime.lastError)return rej(new Error('Injection failed: '+chrome.runtime.lastError.message));
							chrome.tabs.sendMessage(tabId,{action:'extractStructuredContent'},r2=>{
								if(chrome.runtime.lastError)return rej(new Error(chrome.runtime.lastError.message));
								if(!r2||!r2.success) return rej(new Error(r2?.error||'Extraction failed after inject'));
								res(r2.data);
							});
						});
					}catch(e){ return rej(new Error('Injection exception: '+e.message)); }
					return;
				}
				return rej(new Error(msg));
			}
			if(!resp||!resp.success) return rej(new Error(resp?.error||'Extraction failed'));
			res(resp.data);
		});
	});
}

async function classify(urlKey,data){
	if(classificationCache.has(urlKey)) return classificationCache.get(urlKey);
	try {
		const prompt=`Classify page.\nCATEGORY: <broad>\nTOPIC: <specific>\nAUDIENCE: <audience>\nTitle:${data.title}\nDesc:${data.description||'N/A'}\nHeaders:${(data.headers.h1||[]).slice(0,3).join('; ')}\nBody:${data.body.slice(0,300)}`;
		const t=await gem(prompt);
		const category=(t.match(/CATEGORY:\s*([^\n]+)/i)||[, 'Unknown'])[1].trim();
		const topic=(t.match(/TOPIC:\s*([^\n]+)/i)||[, 'Unknown'])[1].trim();
		const audience=(t.match(/AUDIENCE:\s*([^\n]+)/i)||[, 'Unknown'])[1].trim();
		const result={category,topic,audience}; classificationCache.set(urlKey,result); return result;
	}catch{ return {category:'Unknown',topic:'Unknown',audience:'Unknown'}; }
}

async function compare(pageCategory,pageTopic,userTopic){
	const key=`${pageCategory}|${pageTopic}|${userTopic}`.toLowerCase();
	if(comparisonCache.has(key)) return comparisonCache.get(key);
	try {
		const prompt=`Determine if PAGE_TOPIC is relevant to USER_TOPIC.
PAGE_CATEGORY: ${pageCategory}
PAGE_TOPIC: ${pageTopic}
USER_TOPIC: ${userTopic}
Instructions:
- Answer MATCH yes only if PAGE_TOPIC is the same, a close synonym, or a clearly focused sub/super topic that would help study USER_TOPIC directly.
- Super broad categories without specific alignment -> no.
- If PAGE_TOPIC only mentions USER_TOPIC tangentially -> no.
- Provide CONFIDENCE 0-100 integer.
Output EXACT format:
MATCH: yes|no
CONFIDENCE: <0-100>
REASON: <concise>`;
		const t=await gem(prompt);
		const isRelevant=/MATCH:\s*yes/i.test(t);
		const c=t.match(/CONFIDENCE:\s*(\d{1,3})/i); const confidence=c? Math.min(100,parseInt(c[1],10))/100:0;
		const reason=(t.match(/REASON:\s*([^\n]+)/i)||[, ''])[1].trim();
		const result={isRelevant,confidence,reason}; comparisonCache.set(key,result); return result;
	}catch{ return {isRelevant:false,confidence:0,reason:'Comparison failed'}; }
}

/**
 * Uses the Gemini model to suggest a single, relevant YouTube video URL for a given topic.
 * @param {string} topic The topic to search for.
 * @returns {Promise<string | null>} The canonical YouTube URL or null.
 */
async function suggestVideo(topic){
    // Ensure API_KEY is defined. (Assumes it's available in this scope)
    if(typeof API_KEY === 'undefined' || !API_KEY) return null;
    
    const debugLog = [];
    let resultUrl = null; // Variable to hold the final URL

    try {
        // --- Attempt 1: Strict URL-only prompt ---
        const prompt = `Provide ONE YouTube video URL helpful for topic: ${topic}. Output the URL ONLY, do not include any other text, markdown, or explanation.`;
        const raw = await gem(prompt);
        debugLog.push({phase:'raw',snippet:raw.slice(0,180)});
        resultUrl = extractFirstYoutubeUrl(raw);

        if (resultUrl) {
            return resultUrl;
        }

        // --- Attempt 2: Retry with explicit canonical format instruction ---
        const retryPrompt = `Return the canonical YouTube watch URL (https://www.youtube.com/watch?v=VIDEOID) for a video about ${topic}. Output the URL ONLY.`;
        const raw2 = await gem(retryPrompt);
        debugLog.push({phase:'retry',snippet:raw2.slice(0,180)});
        resultUrl = extractFirstYoutubeUrl(raw2);

        if (resultUrl) {
            return resultUrl;
        }

    } catch(e) { 
        // Log network or API errors
        debugLog.push({phase:'error',error:e.message}); 
        // The function will fall through to the 'finally' block
    } finally {
        // CRITICAL FIX: Use a finally block to ensure debug logging always runs, 
        // even on success or error. Added a check for chrome environment.
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({suggestionDebug: debugLog});
        }
    }

    return null;
}

/**
 * Reliably extracts and canonicalizes the first 11-character YouTube video ID
 * found in a text string into the standard watch URL format.
 * @param {string} text The text output from the model.
 * @returns {string | null} The canonical YouTube URL or null if no ID is found.
 */
function extractFirstYoutubeUrl(text){
    if(!text || typeof text !== 'string') return null;

    // Comprehensive regex to extract the 11-character video ID from:
    // - youtu.be/VIDEOID
    // - youtube.com/watch?v=VIDEOID (and ignores extra query params)
    // - youtube.com/shorts/VIDEOID
    const videoIdRegex = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|(?:embed|v|shorts)\/))([a-zA-Z0-9_-]{11})/;
    const match = text.match(videoIdRegex);

    if (match && match[1]) {
        const videoId = match[1];
        // Always return the clean, canonical watch URL (https://www.youtube.com/watch?v=VIDEOID)
        return `https://www.youtube.com/watch?v=${videoId}`;
    }
    
    return null;
}

async function checkActiveTab(){
	try {
		const {enabled,topic,isMonitoring}=await chrome.storage.sync.get(['enabled','topic','isMonitoring']);
		if(!enabled||!isMonitoring){ chrome.action.setBadgeText({text:''}); return; }
		const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if(!tab) return; try { const u=new URL(tab.url); if(!/^https?:/.test(u.protocol)) return; } catch { return; }
		if(!API_KEY){ chrome.action.setBadgeText({text:'KEY'}); chrome.action.setBadgeBackgroundColor({color:'#e67e22'}); return; }
		const data=await extractStructured(tab.id);
		lastCheckedUrl = tab.url;
		if(!topic){ chrome.action.setBadgeText({text:''}); chrome.storage.local.set({currentState:{currentContent:data.title.slice(0,120),pageUrl:data.url,timestamp:new Date().toISOString(),tabId:tab.id}}); return; }
		const urlKey=data.url.split('#')[0]; const cls=await classify(urlKey,data); const {isRelevant,confidence,reason}=await compare(cls.category,cls.topic,topic);
		// Heuristic short-circuit AFTER classification but BEFORE acting on model result: if heuristics strongly relevant, override
		let finalRelevant=isRelevant, finalConfidence=confidence, finalReason=reason;
		const heuristic=heuristicRelevance(topic,data);
		if(heuristic.decided){
			finalRelevant=heuristic.isRelevant;
			finalConfidence=heuristic.confidence;
			finalReason=heuristic.reason + ' (heuristic)';
		}
		chrome.tabs.sendMessage(tab.id,{action:'updateHighlight',color:finalRelevant?'#2ecc71':'#e74c3c',reason:finalReason||(finalRelevant?'Relevant':'Not relevant')});
		chrome.storage.local.set({ currentState:{ currentContent:data.title.slice(0,120), contentTopic:`${cls.category} - ${cls.topic}\n(${cls.audience})`, selectedTopic:topic, isRelevant:finalRelevant, confidence:finalConfidence, reason:finalReason, timestamp:new Date().toISOString(), tabId:tab.id } });
		if(finalRelevant && finalConfidence>=0.6){
			chrome.action.setBadgeText({text:'✓'});
			chrome.action.setBadgeBackgroundColor({color:'#2ecc71'});
			chrome.alarms.clear('youtubeSuggestion');
			chrome.storage.sync.set({timerEndTime:null,timerStartedAt:null,timerDurationMs:null});
			chrome.storage.local.remove('nextVideoUrl');
			// If we had an earlier off-topic tab different from this one, attempt to close it now
			if(lastOffTopicTabId && lastOffTopicTabId!==tab.id){
				try { chrome.tabs.remove(lastOffTopicTabId); } catch(_){}
			}
			lastOffTopicTabId = null;
		}else{
			chrome.action.setBadgeText({text:'!'});
			chrome.action.setBadgeBackgroundColor({color:'#e74c3c'});
			const {nextVideoUrl}=await chrome.storage.local.get('nextVideoUrl');
			if(!nextVideoUrl){ const vid=await suggestVideo(topic); if(vid) chrome.storage.local.set({nextVideoUrl:vid}); }
			const {timerEndTime}=await chrome.storage.sync.get('timerEndTime');
			if(!timerEndTime){
				const {timer=5}=await chrome.storage.sync.get('timer');
				const endTime = Date.now()+timer*60000;
				chrome.alarms.create('youtubeSuggestion',{when:endTime});
				await chrome.storage.sync.set({timerEndTime:endTime,timerStartedAt:Date.now(),timerDurationMs:timer*60000});
				startTimerTick();
			}
			lastOffTopicTabId = tab.id; // remember this off-topic tab so we can close it later when a relevant tab appears
		}
		chrome.runtime.sendMessage({action:'contentStateUpdate',state:{isRelevant:finalRelevant,confidence:finalConfidence,reason:finalReason,pageTitle:data.title,pageUrl:data.url}});
	} catch(e){ console.error('Check failed',e); chrome.action.setBadgeText({text:'x'}); chrome.action.setBadgeBackgroundColor({color:'#e74c3c'}); }
}

chrome.runtime.onMessage.addListener((req,_s,sendResponse)=>{
	if(req.action==='checkGeminiConnection'){
		if(!API_KEY){ sendResponse({success:false,error:'Missing API key'}); return true; }
		if(isCheckingConnection){ sendResponse({success:modelConfigured,error:'Check in progress'}); return true; }
		isCheckingConnection=true;
		const started=Date.now();
		const controller=new AbortController();
		const timeout=setTimeout(()=>{ try { controller.abort(); } catch{} },6000);
		GoogleGenerativeAI.generateContent(API_KEY,'ping',{signal:controller.signal}).then(()=>{
			modelConfigured=true;
			sendResponse({success:true,model:GoogleGenerativeAI.getCurrentModel(),ms:Date.now()-started});
		}).catch(err=>{
			modelConfigured=false;
			const aborted = err?.name==='AbortError';
			const diag={
				message:aborted? 'Connection timeout': err.message,
				status:err.status,
				model:GoogleGenerativeAI.getCurrentModel(),
				ms:Date.now()-started,
				rawSnippet: err.raw? JSON.stringify(err.raw).slice(0,180):undefined,
				aborted
			};
			sendResponse({success:false,error:diag.message,diagnostics:diag});
		}).finally(()=>{ clearTimeout(timeout); isCheckingConnection=false; });
		return true;
	}
	if(req.action==='setExtensionState'){
		const prevEnabled=isExtensionEnabled, prevTopic=selectedTopic, prevTimer=originalTimer; isExtensionEnabled=req.enabled; selectedTopic=req.topic||''; originalTimer=req.timer||0; chrome.alarms.clear('contentCheck');
		if(isExtensionEnabled){ if(!prevEnabled||prevTopic!==selectedTopic||prevTimer!==originalTimer){ chrome.alarms.clear('youtubeSuggestion'); chrome.storage.sync.set({timerEndTime:null}); } if(API_KEY && !modelConfigured){ GoogleGenerativeAI.generateContent(API_KEY,'ping').then(()=>{ modelConfigured=true; }).catch(()=>{ modelConfigured=false; chrome.action.setBadgeText({text:'KEY'}); chrome.action.setBadgeBackgroundColor({color:'#e67e22'}); }); } else if(!API_KEY){ chrome.action.setBadgeText({text:'KEY'}); chrome.action.setBadgeBackgroundColor({color:'#e67e22'}); } scheduleCheck(); }
		else { chrome.action.setBadgeText({text:''}); chrome.alarms.clear('youtubeSuggestion'); chrome.storage.sync.set({timerEndTime:null}); }
		// Manage 5s monitor loop
		chrome.storage.sync.get(['isMonitoring']).then(r=>{ if(isExtensionEnabled && r.isMonitoring){ startMonitorLoop(); } else { stopMonitorLoop(); } });
		sendResponse({success:true}); return true;
	}
	if(req.action==='checkContent'){ scheduleCheck(); sendResponse({success:true}); return true; }
	if(req.action==='pageSoftChange'){
		// Dynamic page mutation or in-tab navigation (SPA) reported by content script
		// Throttle: rely on existing scheduleCheck debounce plus a short guard to avoid flooding
		if(isExtensionEnabled){
			// Invalidate cached classification for current active tab (same URL but changed content)
			try {
				chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>{
					const tab=tabs[0];
					if(tab && tab.url){
						try {
							const baseUrl = tab.url.split('#')[0];
							if(classificationCache.has(baseUrl)){
								classificationCache.delete(baseUrl);
								comparisonCache.clear();
								console.debug('[SageMode] Cleared classification & comparison cache due to content change');
							}
						} catch(e){ /* silent */ }
					}
					// Re-schedule with slight delay to allow layout stabilization
					scheduleCheck();
				});
			} catch(e){ /* ignore */ }
		}
		if(sendResponse) sendResponse({received:true});
		return true;
	}
});

chrome.tabs.onUpdated.addListener((tabId,info,tab)=>{ 
			// Final resort: try extracting from concatenated debugging raw snippets (if any captured) -- not available here, so just fail
	if(info.status==='complete'){
		scheduleCheck();
		// Second pass after 2.5s for SPA hydration or late content
		setTimeout(()=>{ if(tab && tab.url===lastCheckedUrl) scheduleCheck(); },2500);
	}
});
chrome.tabs.onActivated.addListener(()=> scheduleCheck());

if(spaUrlPollInterval) clearInterval(spaUrlPollInterval);
spaUrlPollInterval=setInterval(async()=>{ const {enabled,isMonitoring}=await chrome.storage.sync.get(['enabled','isMonitoring']); if(!enabled||!isMonitoring) return; const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if(!tab) return; if(tab.url!==lastCheckedUrl){ scheduleCheck(); } },5000);
// Faster poll to catch in-tab video/video navigation changes (esp. YouTube dynamic loads)
if(spaUrlPollInterval) clearInterval(spaUrlPollInterval);
spaUrlPollInterval=setInterval(async()=>{
	try {
		const {enabled,isMonitoring}=await chrome.storage.sync.get(['enabled','isMonitoring']);
		if(!enabled||!isMonitoring) return;
		const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
		if(!tab) return;
		if(tab.url!==lastCheckedUrl){
			// Clear classification cache for prior URL to force fresh classification
			try { if(lastCheckedUrl){ const basePrev=lastCheckedUrl.split('#')[0]; classificationCache.delete(basePrev); } } catch{}
			lastCheckedUrl = tab.url;
			scheduleCheck();
		}
		// On YouTube watch pages, force periodic re-check even if URL same (video might change via JS)
		if(/https?:\/\/([a-zA-Z0-9-]+\.)?youtube\.com\/watch/.test(tab.url)){
			// randomize slight jitter to avoid synchronous firing
			if(Math.random()<0.15){
				try { const base=tab.url.split('#')[0]; classificationCache.delete(base); comparisonCache.clear(); } catch{}
				scheduleCheck();
			}
		}
	}catch{}
},2500);
chrome.alarms.onAlarm.addListener(async alarm=>{
	if(alarm.name!=='youtubeSuggestion') return;
	try {
		const {enabled,topic}=await chrome.storage.sync.get(['enabled','topic']);
		if(!enabled||!topic){ return; }
		// Final relevance gate: re-classify active tab; abort if now relevant
		try {
			const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
			if(tab && /^https?:/.test(tab.url)){
				const data=await extractStructured(tab.id).catch(()=>null);
				if(data){
					const urlKey=data.url.split('#')[0];
					const cls=await classify(urlKey,data);
					const cmp=await compare(cls.category,cls.topic,topic);
					if(cmp.isRelevant && cmp.confidence>=0.6){
						console.log('[SageMode] Abort opening video: page became relevant.');
						chrome.alarms.clear('youtubeSuggestion');
						chrome.storage.sync.set({timerEndTime:null,timerStartedAt:null,timerDurationMs:null});
						return;
					}
				}
			}
		} catch(reGateErr){ console.warn('[SageMode] relevance re-gate failed (continuing):', reGateErr.message); }
		let {nextVideoUrl}=await chrome.storage.local.get('nextVideoUrl');
		// If we somehow lost the stored URL, attempt to fetch one now before giving up
		if(!nextVideoUrl){
			console.log('[SageMode] No stored video at alarm time; generating on-demand...');
			nextVideoUrl = await suggestVideo(topic);
			if(nextVideoUrl) await chrome.storage.local.set({nextVideoUrl});
		}
		if(!nextVideoUrl){
			console.warn('[SageMode] Unable to obtain a suggestion; aborting open.');
			chrome.runtime.sendMessage({action:'suggestionFailed',reason:'No valid suggestion available'});
			chrome.storage.sync.remove('timerEndTime');
			return;
		}
		let openUrl = nextVideoUrl;
		// Validate (with up to 2 replacement attempts total)
		for(let attempt=0; attempt<2; attempt++){
			try {
				const v = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(openUrl)}`);
				if(v.ok){ break; }
				console.warn(`[SageMode] oEmbed failed (status ${v.status}) for attempt ${attempt+1}`);
			} catch(e){ console.warn('[SageMode] oEmbed network error attempt '+(attempt+1)+':', e.message); }
			const repl = await suggestVideo(topic);
			if(!repl){
				if(attempt===1){
					chrome.runtime.sendMessage({action:'suggestionFailed',reason:'All replacement attempts failed'});
					chrome.storage.local.remove('nextVideoUrl');
					chrome.storage.sync.remove('timerEndTime');
					return;
				}
			} else {
				openUrl = repl; await chrome.storage.local.set({nextVideoUrl:openUrl});
			}
		}
		const [currentTab]=await chrome.tabs.query({active:true,currentWindow:true});
		let createdTab=null;
		try {
			createdTab = await chrome.tabs.create({url:openUrl, active:true});
		} catch(e){ console.warn('[SageMode] failed to create tab directly, retrying:', e.message); createdTab=null; }
		// Fallback retry once if creation failed
		if(!createdTab){
			await new Promise(r=>setTimeout(r,400));
			try { createdTab = await chrome.tabs.create({url:openUrl, active:true}); } catch{}
		}
		if(currentTab && createdTab && currentTab.id!==createdTab.id){
			// Give Chrome a short moment to activate the new tab before closing the old one
			setTimeout(()=>{ chrome.tabs.remove(currentTab.id).catch(()=>{}); },300);
		}
		// Schedule a relevance check on the newly opened suggested video tab so loop continues
		if(createdTab){
			setTimeout(()=>{ try { scheduleCheck(); } catch{} }, 1200); // allow page load start
		}
		chrome.storage.local.remove('nextVideoUrl');
		chrome.storage.sync.remove('timerEndTime');
		chrome.runtime.sendMessage({action:'suggestionOpened',url:openUrl});
	} catch(e){
		console.error('[SageMode] Error during alarm handling:', e);
		chrome.runtime.sendMessage({action:'suggestionFailed',reason:e.message||'Unknown error'});
		chrome.storage.sync.remove('timerEndTime');
	}
});

chrome.runtime.onInstalled.addListener(()=>{ chrome.storage.sync.get(['enabled','timer'],r=>{ if(r.enabled===undefined) chrome.storage.sync.set({enabled:false}); if(r.timer===undefined) chrome.storage.sync.set({timer:5}); }); });

setInterval(async()=>{ try { const {timerEndTime}=await chrome.storage.sync.get('timerEndTime'); if(timerEndTime){ chrome.runtime.sendMessage({action:'timerUpdate',timerEndTime}); } } catch{} },15000);

export {};
