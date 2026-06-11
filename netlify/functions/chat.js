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

// Detect if the latest user message is requesting a write action
function detectWriteIntent(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  const msg = last.content.toLowerCase();

  const calendarTriggers = ['add to calendar', 'create event', 'schedule a', 'put on my calendar', 'add a', 'block time', 'remind me', 'set up a meeting', 'add pickleball', 'add a session', 'schedule me', 'create a'];
  const calendarDeleteTriggers = ['remove', 'delete', 'cancel', 'remove from calendar', 'delete from calendar', 'cancel the event', 'remove the event', 'delete the event', 'remove my', 'delete my', 'cancel my'];
  const emailTriggers = ['send an email', 'send email', 'email to', 'draft an email', 'draft email', 'write an email', 'shoot an email', 'send a message to', 'email my', 'send my'];

  // Check delete before create to avoid false positives
  if (calendarDeleteTriggers.some(t => msg.includes(t)) && (msg.includes('event') || msg.includes('meeting') || msg.includes('session') || msg.includes('appointment') || msg.includes('calendar'))) return 'calendar_delete';
  if (calendarTriggers.some(t => msg.includes(t))) return 'calendar';
  if (emailTriggers.some(t => msg.includes(t))) return 'email';
  return null;
}

// Build a strong enforcement reminder injected as the last user turn
function buildEnforcementReminder(intent) {
  if (intent === 'calendar') {
    return `SYSTEM REMINDER: The user just requested a calendar event. You MUST end your response with an ACTION_BLOCK in this exact format (no exceptions):
ACTION_BLOCK:{"type":"calendar","action":"create","summary":"<title>","start":"<ISO datetime>","end":"<ISO datetime>","description":"<optional>","timeZone":"America/New_York"}

Do not skip this. Do not say you will create it. Output the ACTION_BLOCK JSON on its own line at the very end.`;
  }
  if (intent === 'calendar_delete') {
    return `SYSTEM REMINDER: The user wants to DELETE a calendar event. The calendar context above contains real events with real IDs in this format: "- Event Name at Date/Time [ID: actual_google_id_here]"

You MUST:
1. Find the matching event in the [CALENDAR] section above
2. Copy the EXACT ID from inside the [ID: ...] brackets — do NOT make up an ID
3. End your response with this ACTION_BLOCK using the REAL ID:
ACTION_BLOCK:{"type":"calendar","action":"delete","eventId":"<EXACT_ID_FROM_CALENDAR_CONTEXT>","summary":"<event title>","start":"<event start time>"}

CRITICAL: The eventId MUST be the real Google Calendar ID from the context. It will look like random letters and numbers, NOT a human-readable string like "dinner-at-home-2026-06-11". If you cannot find the event ID in the calendar context, say so instead of making one up.`;
  }
  if (intent === 'email') {
    return `SYSTEM REMINDER: The user just requested an email. You MUST end your response with an ACTION_BLOCK in this exact format (no exceptions):
ACTION_BLOCK:{"type":"email","action":"send","to":"<email>","subject":"<subject>","body":"<full body text>"}

Do not skip this. Do not say you will send it. Output the ACTION_BLOCK JSON on its own line at the very end.`;
  }
  return null;
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
        const memRes = await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/memories?order=created_at.desc&limit=50`,
          'GET', SUPABASE_KEY
        );
        if (memRes.status === 200) {
          const mems = JSON.parse(memRes.body);
          if (mems.length > 0) memorySummary = mems.map(m => m.content).join('\n');
        }

        const convRes = await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/conversations?order=created_at.desc&limit=20`,
          'GET', SUPABASE_KEY
        );
        if (convRes.status === 200) {
          const convs = JSON.parse(convRes.body);
          if (convs.length > 0) recentConversations = convs.reverse().map(c => `${c.role}: ${c.content}`).join('\n');
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
- If Cole says "remember that..." or "don't forget..." acknowledge and the system will save it
- If Cole asks "what do you remember?" summarize the memories above
- Use memories naturally in conversation without announcing them`;

    // Detect write intent and inject enforcement reminder as a system turn
    const writeIntent = detectWriteIntent(messages);
    const enforcementReminder = writeIntent ? buildEnforcementReminder(writeIntent) : null;

    // Build final messages array — inject enforcement as extra user message if needed
    // For delete intent, also note that calendar context will be in the system prompt from enrichWithGoogle
    const finalMessages = enforcementReminder
      ? [...messages, { role: 'user', content: enforcementReminder }]
      : messages;

    // Bump max_tokens for write actions so there's room for the ACTION_BLOCK
    const finalMaxTokens = writeIntent ? Math.max(max_tokens || 1000, 600) : (max_tokens || 1000);

    // Call Anthropic
    const response = await anthropicRequest({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: finalMaxTokens,
      system: enrichedSystem,
      messages: finalMessages
    }, ANTHROPIC_KEY);

    // Save conversation to Supabase
    if (SUPABASE_URL && SUPABASE_KEY && response.status === 200) {
      try {
        const lastUserMsg = messages[messages.length - 1];
        const responseData = JSON.parse(response.body);
        const assistantMsg = responseData.content?.[0]?.text || '';

        await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/conversations`,
          'POST', SUPABASE_KEY,
          { role: 'user', content: lastUserMsg.content }
        );

        await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/conversations`,
          'POST', SUPABASE_KEY,
          { role: 'assistant', content: assistantMsg }
        );

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
