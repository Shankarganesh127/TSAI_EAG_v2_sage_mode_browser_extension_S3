// Local test script to verify Gemini API connectivity using the extension's Gemini client.
// Usage (PowerShell):
//   $env:GEMINI_API_KEY="your-key-here"; node test_gemini.js
// Or create a .env (NOT committed) and load manually.

import { GoogleGenerativeAI } from './lib/gemini.js';

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();

if (!GEMINI_API_KEY) {
    console.error('[ERROR] GEMINI_API_KEY not set. Set environment variable before running.');
    process.exit(1);
}

async function testGeminiAPI() {
    console.log('🔍 Testing Gemini API connection with model fallback...');
    try {
        const response = await GoogleGenerativeAI.generateContent(
            GEMINI_API_KEY,
            'Reply ONLY with: Hello, I am working!'
        );
        console.log('\n✅ API Response Raw Text:\n', response);
        if (/Hello, I am working!/i.test(response)) {
            console.log('\n🎉 Success! Gemini connectivity verified.');
        } else {
            console.warn('\n⚠️ Received unexpected content. Connectivity OK but prompt adherence off.');
        }
    } catch (error) {
        console.error('\n❌ Gemini API Error');
        console.error('Message:', error.message);
        if (error.status) console.error('Status:', error.status);
        if (error.raw) console.error('Raw:', JSON.stringify(error.raw, null, 2));
        console.error('\nTroubleshooting Tips:');
        console.error('1. Verify the API key is enabled for the Gemini API in Google AI Studio.');
        console.error('2. Ensure you have not exhausted quota (look for 429 status).');
        console.error('3. If status 403: key may lack permissions or model restricted.');
        console.error('4. If status 404: model name may be unavailable in your region; fallback should rotate.');
        console.error('5. Re-run with a fresh key if persistent 401/403.');
        process.exit(2);
    }
}

testGeminiAPI();