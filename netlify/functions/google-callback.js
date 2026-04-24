const https = require('https');

function post(url, data) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = new URLSearchParams(data).toString();
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const { code } = event.queryStringParameters || {};
  if (!code) return { statusCode: 400, body: 'No code provided' };

  try {
    const tokens = await post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'https://anisa-ai-00.netlify.app/auth/callback',
      grant_type: 'authorization_code'
    });

    // Store tokens in cookie and redirect back to Anisa
    const tokenData = encodeURIComponent(JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry: Date.now() + (tokens.expires_in * 1000)
    }));

    return {
      statusCode: 302,
      headers: {
        'Set-Cookie': `anisa_google=${tokenData}; Path=/; Secure; SameSite=Lax; Max-Age=2592000`,
        'Location': '/?google=connected'
      },
      body: ''
    };
  } catch (err) {
    return { statusCode: 500, body: `Auth error: ${err.message}` };
  }
};
