const https = require('https');

function googlePost(path, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'gmail.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function makeEmail(to, subject, body) {
  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body
  ].join('\r\n');
  return Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const token = event.headers.authorization?.replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No token' }) };

  try {
    const { action, to, subject, body: emailBody, draftId } = JSON.parse(event.body);

    let result;

    if (action === 'draft') {
      // Save as draft
      const raw = makeEmail(to, subject, emailBody);
      result = await googlePost('/gmail/v1/users/me/drafts', token, {
        message: { raw }
      });
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, draftId: result.body.id, message: 'Draft saved successfully' })
      };

    } else if (action === 'send') {
      // Send email directly
      const raw = makeEmail(to, subject, emailBody);
      result = await googlePost('/gmail/v1/users/me/messages/send', token, { raw });
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, messageId: result.body.id, message: 'Email sent successfully' })
      };

    } else if (action === 'send_draft') {
      // Send existing draft
      result = await googlePost(`/gmail/v1/users/me/drafts/send`, token, { id: draftId });
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: 'Draft sent successfully' })
      };

    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid action' }) };
    }

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
