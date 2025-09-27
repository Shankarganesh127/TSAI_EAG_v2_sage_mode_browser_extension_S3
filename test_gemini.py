import requests
import time
import json
import re
import os
from typing import Optional, Tuple

# Load key from environment variable for safety. Set GEMINI_API_KEY before running.
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '').strip()
if not GEMINI_API_KEY:
    print("[WARN] GEMINI_API_KEY environment variable not set. Set it before running this test.")
URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent'
MAX_RETRIES = 3
BASE_DELAY = 1  # Base delay in seconds

def extract_retry_delay(error_message: str) -> float:
    """Extract retry delay from error message."""
    if not error_message:
        return BASE_DELAY
    
    match = re.search(r'retry in ([\d.]+)s', error_message)
    if match:
        return float(match.group(1))
    return BASE_DELAY

def make_api_request(retry_count: int = 0) -> Tuple[bool, Optional[str], Optional[str]]:
    """Make API request with retries and proper error handling."""
    request_body = {
        "contents": [{
            "parts": [{
                "text": "Hello, can you respond with a simple 'Hello, I am working!' if you receive this message?"
            }]
        }],
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 50  # Reduced to minimize token usage
        }
    }

    try:
        response = requests.post(
            f"{URL}?key={GEMINI_API_KEY}",
            json=request_body,
            timeout=10  # Add timeout
        )
        
        data = response.json()
        
        if response.status_code == 200:
            if 'candidates' in data and len(data['candidates']) > 0:
                return True, data['candidates'][0]['content']['parts'][0]['text'], None
            return False, None, "Unexpected response format"
            
        # Handle quota exceeded
        if response.status_code == 429:
            error_msg = data.get('error', {}).get('message', '')
            retry_delay = extract_retry_delay(error_msg)
            
            if retry_count < MAX_RETRIES:
                print(f"\nQuota exceeded. Attempt {retry_count + 1}/{MAX_RETRIES}")
                print(f"Waiting {retry_delay} seconds before retry...")
                time.sleep(retry_delay)
                return make_api_request(retry_count + 1)
            
            return False, None, f"Quota exceeded after {MAX_RETRIES} retries"
            
        # Other errors
        error_msg = data.get('error', {}).get('message', 'Unknown error')
        return False, None, f"API Error ({response.status_code}): {error_msg}"
            
    except requests.Timeout:
        return False, None, "Request timed out"
    except requests.RequestException as e:
        return False, None, f"Network error: {str(e)}"
    except json.JSONDecodeError:
        return False, None, "Invalid JSON response"
    except Exception as e:
        return False, None, f"Unexpected error: {str(e)}"

def test_video_suggestion():
    """Test the video suggestion functionality."""
    print("\nTesting video suggestion functionality...")
    print("Using simple URL extraction")
    
    request_body = {
        "contents": [{
            "parts": [{
                "text": """Suggest a popular, currently available educational YouTube video about Python programming.

Consider these STRICT requirements:
1. Must be from a major educational channel (like Coursera, Khan Academy, freeCodeCamp, etc.)
2. Should be a recent video (preferably from the last 2 years)
3. Must have high view count (>100K views) to ensure it's still available
4. Must be from verified/reputable content creators

Format your response exactly like this:
VIDEO_TITLE: [exact title as shown on YouTube]
VIDEO_URL: [complete YouTube URL, must be from a major channel]
REASON: [briefly explain why this is a reliable source]"""
            }]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 100
        }
    }

    try:
        response = requests.post(
            f"{URL}?key={GEMINI_API_KEY}",
            json=request_body,
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            if 'candidates' in data and data['candidates']:
                result = data['candidates'][0]['content']['parts'][0]['text']
                print("\n✅ Got response from API:")
                print(result)
                
                # Check if we got a valid YouTube URL
                url_match = re.search(r'VIDEO_URL:\s*(https:\/\/(?:www\.)?youtube\.com\/[^\s]+)', result, re.I)
                if url_match:
                    url = url_match.group(1)
                    print("\n✅ Successfully extracted video URL:")
                    print(url)
                    
                    # Verify URL format
                    if 'youtube.com/watch?v=' in url:
                        print("✅ URL format is correct")
                    else:
                        print("❌ URL format might be incorrect")
                else:
                    print("\n❌ No valid YouTube URL found in response")
            else:
                print("\n❌ No valid response content")
        else:
            print(f"\n❌ API Error ({response.status_code}):")
            print(response.json().get('error', {}).get('message', 'Unknown error'))
            
    except Exception as e:
        print(f"\n❌ Error testing video suggestion: {str(e)}")
        print("\nTroubleshooting tips:")
        print("1. Check if you've exceeded your API quota")
        print("2. Verify your API key is valid")
        print("3. Try again in a few minutes if quota exceeded")

if __name__ == "__main__":
    test_video_suggestion()