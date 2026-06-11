const https = require('https');

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };
  }
  const accessToken = authHeader.replace('Bearer ', '').trim();

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action } = payload;

  // ── CREATE ──
  if (action === 'create') {
    const { summary, start, end, description = '', timeZone = 'America/New_York' } = payload;
    if (!summary || !start || !end) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'summary, start, end required' }) };
    }

    const eventBody = JSON.stringify({
      summary,
      description,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone }
    });

    const result = await httpsRequest({
      hostname: 'www.googleapis.com',
      path: '/calendar/v3/calendars/primary/events',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(eventBody)
      }
    }, eventBody);

    if (result.status === 200 || result.status === 201) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: result.body.id, link: result.body.htmlLink }) };
    } else {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: result.body?.error?.message || 'Failed to create event', details: result.body }) };
    }
  }

  // ── DELETE ──
  if (action === 'delete') {
    const { eventId } = payload;
    if (!eventId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventId required' }) };

    const result = await httpsRequest({
      hostname: 'www.googleapis.com',
      path: `/calendar/v3/calendars/primary/events/${eventId}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (result.status === 204 || result.status === 200) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } else {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: 'Failed to delete event', details: result.body }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};
