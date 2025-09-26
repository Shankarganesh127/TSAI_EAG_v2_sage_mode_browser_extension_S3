// @google/generative-ai SDK
const GoogleGenerativeAI = {
  generateContent: async function(apiKey, prompt) {
    const url = 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro-002:generateContent';
    console.log('Making request to:', url);

    const requestBody = {
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    };
    console.log('Request body:', requestBody);

        const makeRequest = async (retryCount = 0) => {
          const response = await fetch(`${url}?key=${apiKey}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });

          if (!response.ok) {
            const errorData = await response.json();
            const error = errorData.error;
            
            // Check if this is a quota exceeded error
            if (error && error.message && error.message.includes('quota exceeded') && retryCount < 3) {
              const retryAfter = error.message.match(/retry in ([\d.]+)s/);
              if (retryAfter) {
                const waitTime = Math.ceil(parseFloat(retryAfter[1]) * 1000);
                console.log(`Quota exceeded, waiting ${waitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return makeRequest(retryCount + 1);
              }
            }
            
            throw new Error(error?.message || 'API request failed');
          }

        const data = await response.json();
        console.log('Content Generation Response:', data);
        
        if (data.candidates && data.candidates.length > 0) {
          return {
            text: data.candidates[0].content.parts[0].text
          };
        }
        
        if (data.error) {
          throw new Error(data.error.message || 'Unknown API error');
        }
        
        throw new Error('No valid response from Gemini API');
      } catch (error) {
        console.error('Gemini API Error:', error);
        throw error;
      }
    }
  };
})();