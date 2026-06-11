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

function buildRawEmail(to, subject, body) {
  const msg = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    '',
    body
  ].join('\r\n');
  return Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  const { action, to, subject, body: emailBody } = payload;

  if (!to || !subject || !emailBody) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'to, subject, and body are required' }) };
  }

  const raw = buildRawEmail(to, subject, emailBody);

  // ── DRAFT ──
  if (action === 'draft') {
    const draftPayload = JSON.stringify({ message: { raw } });
    const result = await httpsRequest({
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/drafts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(draftPayload)
      }
    }, draftPayload);

    if (result.status === 200 || result.status === 201) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, draftId: result.body.id }) };
    } else {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: result.body?.error?.message || 'Failed to create draft', details: result.body }) };
    }
  }

  // ── SEND ──
  if (action === 'send') {
    const sendPayload = JSON.stringify({ raw });
    const result = await httpsRequest({
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(sendPayload)
      }
    }, sendPayload);

    if (result.status === 200 || result.status === 201) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: result.body.id }) };
    } else {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: result.body?.error?.message || 'Failed to send email', details: result.body }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};
