const https = require('https');

function supabaseRequest(url, method, key, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=representation',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function anthropicRequest(body, apiKey) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (err) => resolve({ status: 500, body: JSON.stringify({ error: err.message }) }));
    req.write(data);
    req.end();
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

  if (!ANTHROPIC_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'API key not configured' }) };

  try {
    const { messages, system, model, max_tokens, saveMemory, memoryContent } = JSON.parse(event.body);

    // Handle explicit memory save
    if (saveMemory && memoryContent && SUPABASE_URL && SUPABASE_KEY) {
      await supabaseRequest(
        `${SUPABASE_URL}/rest/v1/memories`,
        'POST', SUPABASE_KEY,
        { category: 'user_note', content: memoryContent }
      );
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ saved: true })
      };
    }

    // Load memories from Supabase
    let memorySummary = '';
    let recentConversations = '';

    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        // Get all knowledge memories
        const memRes = await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/memories?order=created_at.desc&limit=50`,
          'GET', SUPABASE_KEY
        );
        if (memRes.status === 200) {
          const mems = JSON.parse(memRes.body);
          if (mems.length > 0) {
            memorySummary = mems.map(m => m.content).join('\n');
          }
        }

        // Get recent conversations (last 20 messages)
        const convRes = await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/conversations?order=created_at.desc&limit=20`,
          'GET', SUPABASE_KEY
        );
        if (convRes.status === 200) {
          const convs = JSON.parse(convRes.body);
          if (convs.length > 0) {
            recentConversations = convs.reverse().map(c => `${c.role}: ${c.content}`).join('\n');
          }
        }
      } catch (e) {
        console.log('Memory fetch error:', e.message);
      }
    }

    // Build enriched system prompt with memory
    const enrichedSystem = `${system}

## What Anisa Remembers About Cole
${memorySummary || 'No memories stored yet.'}

${recentConversations ? `## Recent Conversation Context\n${recentConversations}` : ''}

## Memory Instructions
- If Cole says "remember that..." or "don't forget..." → acknowledge and the system will save it
- If Cole asks "what do you remember?" → summarize the memories above
- Use memories naturally in conversation without announcing them`;

    // Call Anthropic
    const response = await anthropicRequest({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 1000,
      system: enrichedSystem,
      messages
    }, ANTHROPIC_KEY);

    // Save conversation to Supabase
    if (SUPABASE_URL && SUPABASE_KEY && response.status === 200) {
      try {
        const lastUserMsg = messages[messages.length - 1];
        const responseData = JSON.parse(response.body);
        const assistantMsg = responseData.content?.[0]?.text || '';

        // Save user message
        await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/conversations`,
          'POST', SUPABASE_KEY,
          { role: 'user', content: lastUserMsg.content }
        );

        // Save assistant message
        await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/conversations`,
          'POST', SUPABASE_KEY,
          { role: 'assistant', content: assistantMsg }
        );

        // Auto-detect memory saves ("remember that...")
        const userText = lastUserMsg.content.toLowerCase();
        if (userText.includes('remember that') || userText.includes('remember,') || userText.includes("don't forget")) {
          await supabaseRequest(
            `${SUPABASE_URL}/rest/v1/memories`,
            'POST', SUPABASE_KEY,
            { category: 'user_note', content: lastUserMsg.content }
          );
        }
      } catch (e) {
        console.log('Memory save error:', e.message);
      }
    }

    return {
      statusCode: response.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: response.body
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
