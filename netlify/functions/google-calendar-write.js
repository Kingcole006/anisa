const https = require('https');

function googleRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'www.googleapis.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const token = event.headers.authorization?.replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };

  try {
    const { action, eventId, summary, description, start, end, attendees } = JSON.parse(event.body);

    let result;

    if (action === 'create') {
      const eventBody = {
        summary,
        description: description || '',
        start: { dateTime: start, timeZone: 'America/New_York' },
        end: { dateTime: end, timeZone: 'America/New_York' },
        ...(attendees ? { attendees: attendees.map(e => ({ email: e })) } : {})
      };
      result = await googleRequest('POST', '/calendar/v3/calendars/primary/events', token, eventBody);

    } else if (action === 'delete') {
      result = await googleRequest('DELETE', `/calendar/v3/calendars/primary/events/${eventId}`, token);

    } else if (action === 'update') {
      const updateBody = { summary, description, start: { dateTime: start, timeZone: 'America/New_York' }, end: { dateTime: end, timeZone: 'America/New_York' } };
      result = await googleRequest('PATCH', `/calendar/v3/calendars/primary/events/${eventId}`, token, updateBody);

    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid action' }) };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(result.body)
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
