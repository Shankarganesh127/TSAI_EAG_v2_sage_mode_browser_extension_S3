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
// Caches (single instances)
const comparisonCache = new Map();
const classificationCache = new Map();

function startTimerTick(){
	if(timerTickInterval) return;
	timerTickInterval=setInterval(async()=>{
		const {timerEndTime}=await chrome.storage.sync.get('timerEndTime');
		if(!timerEndTime){ clearInterval(timerTickInterval); timerTickInterval=null; return; }
		chrome.runtime.sendMessage({action:'timerTick',now:Date.now(),timerEndTime});
	},1000);
}

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
		const prompt=`Relation?\nPAGE_CATEGORY:${pageCategory}\nPAGE_TOPIC:${pageTopic}\nUSER_TOPIC:${userTopic}\nMATCH: yes/no\nCONFIDENCE: 0-100\nREASON: <short>`;
		const t=await gem(prompt);
		const isRelevant=/MATCH:\s*yes/i.test(t);
		const c=t.match(/CONFIDENCE:\s*(\d{1,3})/i); const confidence=c? Math.min(100,parseInt(c[1],10))/100:0;
		const reason=(t.match(/REASON:\s*([^\n]+)/i)||[, ''])[1].trim();
		const result={isRelevant,confidence,reason}; comparisonCache.set(key,result); return result;
	}catch{ return {isRelevant:false,confidence:0,reason:'Comparison failed'}; }
}

async function suggestVideo(topic){
	if(!API_KEY) return null; const trusted=TRUSTED_CHANNEL_PATTERNS; const triedIds=new Set();
	// Soft-fail statuses (exclude 404 so we attempt replacement when truly missing)
	const SOFT_FAIL_STATUSES = new Set([401,403,429]);
	const debugLog = [];

	// Token utilities for title-topic relevance
	const STOP_WORDS = new Set(['the','a','an','and','for','with','of','to','on','in','by','from','about','how','learn','guide','tutorial','course','introduction','intro']);
	function tokenize(str){ return (str||'').toLowerCase().replace(/[^a-z0-9+.# ]+/g,' ').split(/\s+/).filter(w=>w.length>2 && !STOP_WORDS.has(w)); }
	const topicTokens = tokenize(topic);
	function titleRelevant(title){
		const titleTokens = tokenize(title);
		if(!titleTokens.length||!topicTokens.length) return true; // can't decide -> allow
		let overlap=0; for(const t of topicTokens){ if(titleTokens.includes(t)) overlap++; }
		return overlap>0; // at least one meaningful token overlap
	}

	// 1. Try structured JSON MULTI-CANDIDATE approach first
	try {
		const jsonPrompt = `Return a STRICT single-line JSON array ONLY (no backticks). Each element: {video_url, channel, confidence, rationale}. Provide 3-4 diverse CANDIDATES for topic: ${topic}.
Rules:
 - channel substring must include one of: ${trusted.join(', ')} (case-insensitive)
 - video_url canonical EXACT form https://www.youtube.com/watch?v=VIDEOID (11 chars)
 - disallow playlists (&list=), shorts (/shorts/), youtu.be, live, music videos unrelated to education
 - prefer uploads year >=2023
 - high relevance: ensure title likely contains at least one major topic keyword
Example: [{"video_url":"https://www.youtube.com/watch?v=abcdefghijk","channel":"freeCodeCamp","confidence":0.93,"rationale":"Covers core ${topic} concepts"}]`;
		const rawJson = await GoogleGenerativeAI.generateJson(API_KEY, jsonPrompt).catch(e=>{ throw e; });
		debugLog.push({phase:'json-multi-attempt',rawSnippet:rawJson.slice(0,180)});
		let candidates=[];
		try { candidates = JSON.parse(rawJson.trim()); if(!Array.isArray(candidates)) throw new Error('Not array'); } catch(e){ debugLog.push({phase:'json-multi-parse-error',error:e.message}); candidates=[]; }
		const vetted=[];
		for(const c of candidates){
			if(!c||typeof c!=='object') continue;
			const url=c.video_url||c.url; const channel=(c.channel||'').toLowerCase();
			if(!url||!/https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(url)) { vetted.push({url,skip:true,reason:'bad_format'}); continue; }
			if(!trusted.some(p=>channel.includes(p))){ vetted.push({url,skip:true,reason:'untrusted_channel'}); continue; }
			// oEmbed verify
			try {
				const v=await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
				if(v.ok || SOFT_FAIL_STATUSES.has(v.status)){
					let titleOk=true; let title='';
					if(v.ok){ try { const meta=await v.json(); title=meta.title||''; titleOk=titleRelevant(title); } catch{} }
					if(titleOk){ debugLog.push({phase:'json-candidate-accept',url,status:v.status,title}); chrome.storage.local.set({suggestionDebug:debugLog}); return url; }
					debugLog.push({phase:'json-candidate-title-mismatch',url,status:v.status,title});
					vetted.push({url,skip:false,reason:'title_mismatch'});
				} else {
					vetted.push({url,skip:false,reason:'oembed_'+v.status});
				}
			} catch(e){ vetted.push({url,skip:false,reason:'oembed_error_'+e.message}); }
		}
		// fallback to first non-skipped vetted candidate (even if title mismatch) to avoid starvation
		const fallbackCandidate = vetted.find(v=>!v.skip && v.url);
		if(fallbackCandidate){ debugLog.push({phase:'json-fallback-candidate',candidate:fallbackCandidate}); chrome.storage.local.set({suggestionDebug:debugLog}); return fallbackCandidate.url; }
	} catch(e){ debugLog.push({phase:'json-multi-failed',error:e.message}); }

	// 2. Fallback to legacy iterative text prompt approach
	async function verify(url){
		try {
			const r=await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
			if(!r.ok){ return {ok:false, status:r.status, reason:'oEmbed status '+r.status}; }
			const j=await r.json().catch(()=>null);
			if(!j||!j.title) return {ok:false,reason:'oEmbed missing title'};
			const rel=titleRelevant(j.title);
			if(!rel) return {ok:false, status:r.status, reason:'title not matching topic', title:j.title};
			return {ok:true,title:j.title};
		} catch(e){ return {ok:false,reason:'oEmbed fetch error '+e.message}; }
	}
	const base=(a)=>`Return ONLY one viable, currently accessible YouTube educational video.\nTopic: ${topic}\nRules:\n - Channel must be one of (case-insensitive contains): ${trusted.join(', ')}\n - Prefer upload year >= 2023\n - MUST use canonical watch URL form: https://www.youtube.com/watch?v=VIDEOID (11 chars)\n - NO playlists (no &list=), NO shorts (/shorts/), NO youtu.be links, NO live streams\n - If prior attempt invalid${a? ' (bad/unavailable/duplicate)':''}, choose a different trusted channel.\nOutput EXACTLY:\nVIDEO_URL: https://www.youtube.com/watch?v=XXXXXXXXXXX\nCHANNEL: <channel name>`;
	function parse(raw){ if(!raw) return {ok:false,reason:'empty raw'}; const m=raw.match(/VIDEO_URL:\s*(https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11}))/i); if(!m) return {ok:false,reason:'no watch url'}; const url=m[1]; const id=m[2]; if(triedIds.has(id)) return {ok:false,reason:'duplicate id'}; if(/(&|\?)list=|shorts\//i.test(url)) return {ok:false,reason:'playlist/shorts disallowed'}; const chm=raw.match(/CHANNEL:\s*([^\n]+)/i); const ch=(chm? chm[1].trim():'').toLowerCase(); if(!ch) return {ok:false,reason:'missing channel'}; if(!trusted.some(p=>ch.includes(p))) return {ok:false,reason:'untrusted channel'}; return {ok:true,url,id}; }

	let fallback=null; let fallbackMeta=null;
	for(let a=0;a<5;a++){
		try {
			const raw=await gem(base(a));
			const parsed=parse(raw);
			debugLog.push({attempt:a+1,rawSnippet:raw? raw.slice(0,140):'EMPTY',parsedOk:parsed.ok,reason:parsed.reason});
			if(!parsed.ok){ console.warn('[SageMode] suggestion reject:', parsed.reason); continue; }
			triedIds.add(parsed.id);
			const ver=await verify(parsed.url);
			if(ver.ok){ console.log('[SageMode] video verified via oEmbed+title'); debugLog.push({phase:'legacy-accept',title:ver.title}); chrome.storage.local.set({suggestionDebug:debugLog}); return parsed.url; }
			if(SOFT_FAIL_STATUSES.has(ver.status)){ console.warn('[SageMode] oEmbed soft-fail (accepting anyway):', ver.reason); chrome.storage.local.set({suggestionDebug:debugLog}); return parsed.url; }
			console.warn('[SageMode] oEmbed hard reject:', ver.reason,'status',ver.status);
			if(!fallback){ fallback=parsed.url; fallbackMeta=ver.reason; }
		} catch(e){ console.warn('[SageMode] suggestion attempt error', e.message); debugLog.push({attempt:a+1,error:e.message}); }
	}
	if(fallback){ console.warn('[SageMode] using fallback candidate despite verification issues:', fallbackMeta); chrome.storage.local.set({suggestionDebug:debugLog}); return fallback; }
	chrome.storage.local.set({suggestionDebug:debugLog});
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
		chrome.tabs.sendMessage(tab.id,{action:'updateHighlight',color:isRelevant?'#2ecc71':'#e74c3c',reason:reason||(isRelevant?'Relevant':'Not relevant')});
		chrome.storage.local.set({ currentState:{ currentContent:data.title.slice(0,120), contentTopic:`${cls.category} - ${cls.topic}\n(${cls.audience})`, selectedTopic:topic, isRelevant, confidence, reason, timestamp:new Date().toISOString(), tabId:tab.id } });
		if(isRelevant && confidence>=0.6){
			chrome.action.setBadgeText({text:'✓'});
			chrome.action.setBadgeBackgroundColor({color:'#2ecc71'});
			chrome.alarms.clear('youtubeSuggestion');
			chrome.storage.sync.set({timerEndTime:null,timerStartedAt:null,timerDurationMs:null});
			chrome.storage.local.remove('nextVideoUrl');
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
		}
		chrome.runtime.sendMessage({action:'contentStateUpdate',state:{isRelevant,confidence,reason,pageTitle:data.title,pageUrl:data.url}});
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
		sendResponse({success:true}); return true;
	}
	if(req.action==='checkContent'){ scheduleCheck(); sendResponse({success:true}); return true; }
});

chrome.tabs.onUpdated.addListener((tabId,info,tab)=>{ 
	if(info.status==='complete'){
		scheduleCheck();
		// Second pass after 2.5s for SPA hydration or late content
		setTimeout(()=>{ if(tab && tab.url===lastCheckedUrl) scheduleCheck(); },2500);
	}
});
chrome.tabs.onActivated.addListener(()=> scheduleCheck());

if(spaUrlPollInterval) clearInterval(spaUrlPollInterval);
spaUrlPollInterval=setInterval(async()=>{ const {enabled,isMonitoring}=await chrome.storage.sync.get(['enabled','isMonitoring']); if(!enabled||!isMonitoring) return; const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if(!tab) return; if(tab.url!==lastCheckedUrl){ scheduleCheck(); } },5000);
chrome.alarms.onAlarm.addListener(async alarm=>{
	if(alarm.name!=='youtubeSuggestion') return;
	try {
		const {enabled,topic}=await chrome.storage.sync.get(['enabled','topic']);
		if(!enabled||!topic){ return; }
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
		await chrome.tabs.create({url:openUrl});
		if(currentTab) chrome.tabs.remove(currentTab.id).catch(()=>{});
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
