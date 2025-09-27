// Simple test script to verify Gemini API
import { GoogleGenerativeAI } from './lib/gemini.js';

const GEMINI_API_KEY = 'AIzaSyBe4P7dmOiBy6gE9Yys4kk0CHf8r04EC0Q';

async function testGeminiAPI() {
    console.log('Testing Gemini API connection...');
    try {
        const response = await GoogleGenerativeAI.generateContent(
            GEMINI_API_KEY,
            'Hello, can you respond with a simple "Hello, I am working!" if you receive this message?'
        );
        console.log('API Response:', response);
        console.log('Success! The API is working.');
    } catch (error) {
        console.error('API Error:', error.message);
    }
}

testGeminiAPI();