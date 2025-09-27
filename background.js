import { GoogleGenerativeAI } from './lib/gemini.js';

// State
let API_KEY = null;
let modelConfigured = false;
let isExtensionEnabled = false;
let selectedTopic = '';
let originalTimer = 0;
let isCheckingConnection = false;
let pendingCheck = null;
import { GoogleGenerativeAI } from './lib/gemini.js';

let API_KEY=null, modelConfigured=false, isExtensionEnabled=false, selectedTopic='', originalTimer=0, isCheckingConnection=false, pendingCheck=null;
const comparisonCache=new Map();
const classificationCache=new Map();
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
	async function verify(url){ try { const r=await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`); if(!r.ok) return {ok:false,reason:'oEmbed status '+r.status}; const j=await r.json().catch(()=>null); if(!j||!j.title) return {ok:false,reason:'oEmbed missing title'}; return {ok:true}; } catch(e){ return {ok:false,reason:'oEmbed fetch error '+e.message}; } }
	const base=(a)=>`Return ONLY one viable, currently accessible YouTube educational video.\nTopic: ${topic}\nRules:\n - Channel must be one of (case-insensitive contains): ${trusted.join(', ')}\n - Prefer upload year >= 2023\n - MUST use canonical watch URL form: https://www.youtube.com/watch?v=VIDEOID (11 chars)\n - NO playlists (no &list=), NO shorts (/shorts/), NO youtu.be links, NO live streams\n - If prior attempt invalid${a? ' (bad/unavailable/duplicate)':''}, choose a different trusted channel.\nOutput EXACTLY:\nVIDEO_URL: https://www.youtube.com/watch?v=XXXXXXXXXXX\nCHANNEL: <channel name>`;
	function parse(raw){ if(!raw) return {ok:false,reason:'empty raw'}; const m=raw.match(/VIDEO_URL:\s*(https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11}))/i); if(!m) return {ok:false,reason:'no watch url'}; const url=m[1]; const id=m[2]; if(triedIds.has(id)) return {ok:false,reason:'duplicate id'}; if(/(&|\?)list=|shorts\//i.test(url)) return {ok:false,reason:'playlist/shorts disallowed'}; const chm=raw.match(/CHANNEL:\s*([^\n]+)/i); const ch=(chm? chm[1].trim():'').toLowerCase(); if(!ch) return {ok:false,reason:'missing channel'}; if(!trusted.some(p=>ch.includes(p))) return {ok:false,reason:'untrusted channel'}; return {ok:true,url,id}; }
	for(let a=0;a<5;a++){ try{ const raw=await gem(base(a)); const p=parse(raw); if(!p.ok){ console.warn('[SageMode] suggestion reject:',p.reason); continue;} triedIds.add(p.id); const v=await verify(p.url); if(v.ok) return p.url; console.warn('[SageMode] oEmbed reject:',v.reason);} catch(e){ console.warn('[SageMode] suggestion attempt error',e.message);} }
	return null;
}

async function checkActiveTab(){
	try {
		const {enabled,topic,isMonitoring}=await chrome.storage.sync.get(['enabled','topic','isMonitoring']);
		if(!enabled||!isMonitoring){ chrome.action.setBadgeText({text:''}); return; }
		const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); if(!tab) return; try { const u=new URL(tab.url); if(!/^https?:/.test(u.protocol)) return; } catch { return; }
		if(!API_KEY){ chrome.action.setBadgeText({text:'KEY'}); chrome.action.setBadgeBackgroundColor({color:'#e67e22'}); return; }
		const data=await extractStructured(tab.id);
		if(!topic){ chrome.action.setBadgeText({text:''}); chrome.storage.local.set({currentState:{currentContent:data.title.slice(0,120),pageUrl:data.url,timestamp:new Date().toISOString(),tabId:tab.id}}); return; }
		const urlKey=data.url.split('#')[0]; const cls=await classify(urlKey,data); const {isRelevant,confidence,reason}=await compare(cls.category,cls.topic,topic);
		chrome.tabs.sendMessage(tab.id,{action:'updateHighlight',color:isRelevant?'#2ecc71':'#e74c3c',reason:reason||(isRelevant?'Relevant':'Not relevant')});
		chrome.storage.local.set({ currentState:{ currentContent:data.title.slice(0,120), contentTopic:`${cls.category} - ${cls.topic}\n(${cls.audience})`, selectedTopic:topic, isRelevant, confidence, reason, timestamp:new Date().toISOString(), tabId:tab.id } });
		if(isRelevant && confidence>=0.6){ chrome.action.setBadgeText({text:'✓'}); chrome.action.setBadgeBackgroundColor({color:'#2ecc71'}); chrome.alarms.clear('youtubeSuggestion'); chrome.storage.sync.set({timerEndTime:null}); chrome.storage.local.remove('nextVideoUrl'); }
		else { chrome.action.setBadgeText({text:'!'}); chrome.action.setBadgeBackgroundColor({color:'#e74c3c'}); const {nextVideoUrl}=await chrome.storage.local.get('nextVideoUrl'); if(!nextVideoUrl){ const vid=await suggestVideo(topic); if(vid) chrome.storage.local.set({nextVideoUrl:vid}); } const {timerEndTime}=await chrome.storage.sync.get('timerEndTime'); if(!timerEndTime){ const {timer=5}=await chrome.storage.sync.get('timer'); chrome.alarms.create('youtubeSuggestion',{delayInMinutes:timer}); chrome.storage.sync.set({timerEndTime:Date.now()+timer*60000}); }}
		chrome.runtime.sendMessage({action:'contentStateUpdate',state:{isRelevant,confidence,reason,pageTitle:data.title,pageUrl:data.url}});
	} catch(e){ console.error('Check failed',e); chrome.action.setBadgeText({text:'x'}); chrome.action.setBadgeBackgroundColor({color:'#e74c3c'}); }
}

chrome.runtime.onMessage.addListener((req,_s,sendResponse)=>{
	if(req.action==='checkGeminiConnection'){
		if(!API_KEY){ sendResponse({success:false,error:'Missing API key'}); return true; }
		if(isCheckingConnection){ sendResponse({success:modelConfigured,error:'Check in progress'}); return true; }
		isCheckingConnection=true;
		GoogleGenerativeAI.generateContent(API_KEY,'ping').then(()=>{ modelConfigured=true; sendResponse({success:true}); }).catch(err=>{ modelConfigured=false; sendResponse({success:false,error:err.message}); }).finally(()=>{ isCheckingConnection=false; });
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

chrome.tabs.onUpdated.addListener((_id,info)=>{ if(info.status==='complete') scheduleCheck(); });
chrome.tabs.onActivated.addListener(()=> scheduleCheck());
chrome.alarms.onAlarm.addListener(async alarm=>{ if(alarm.name==='youtubeSuggestion'){ const {nextVideoUrl}=await chrome.storage.local.get('nextVideoUrl'); const {enabled,topic}=await chrome.storage.sync.get(['enabled','topic']); if(enabled&&topic&&nextVideoUrl){ let openUrl=nextVideoUrl; try { const v=await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(openUrl)}`); if(!v.ok){ console.warn('[SageMode] Stored video failed oEmbed verification (status '+v.status+'), attempting replacement'); const repl=await suggestVideo(topic); if(repl){ openUrl=repl; chrome.storage.local.set({nextVideoUrl:openUrl}); } else { chrome.storage.local.remove('nextVideoUrl'); chrome.storage.sync.remove('timerEndTime'); return; } } } catch(e){ console.warn('[SageMode] verification error before open',e.message); } const [currentTab]=await chrome.tabs.query({active:true,currentWindow:true}); await chrome.tabs.create({url:openUrl}); if(currentTab) chrome.tabs.remove(currentTab.id).catch(()=>{}); chrome.storage.local.remove('nextVideoUrl'); chrome.storage.sync.remove('timerEndTime'); } }});

chrome.runtime.onInstalled.addListener(()=>{ chrome.storage.sync.get(['enabled','timer'],r=>{ if(r.enabled===undefined) chrome.storage.sync.set({enabled:false}); if(r.timer===undefined) chrome.storage.sync.set({timer:5}); }); });

setInterval(async()=>{ try { const {timerEndTime}=await chrome.storage.sync.get('timerEndTime'); if(timerEndTime){ chrome.runtime.sendMessage({action:'timerUpdate',timerEndTime}); } } catch{} },15000);

export {};
const classificationCache = new Map();
