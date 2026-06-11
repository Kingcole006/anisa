const https = require('https');

function httpsRequest(options) {
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
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No token' }) };
  }
  const accessToken = authHeader.replace('Bearer ', '').trim();

  const action = event.queryStringParameters && event.queryStringParameters.action;
  const query = event.queryStringParameters && event.queryStringParameters.query;
  const fileId = event.queryStringParameters && event.queryStringParameters.fileId;
  const mimeType = event.queryStringParameters && event.queryStringParameters.mimeType;

  // ── SEARCH ──
  if (action === 'search' || !action) {
    if (!query) return { statusCode: 400, headers, body: JSON.stringify({ error: 'query required' }) };

    const encodedQuery = encodeURIComponent(`fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`);
    const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink,size)');
    const path = `/drive/v3/files?q=${encodedQuery}&fields=${fields}&pageSize=8&orderBy=modifiedTime+desc`;

    const result = await httpsRequest({
      hostname: 'www.googleapis.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (result.status === 200) {
      return { statusCode: 200, headers, body: JSON.stringify({ files: result.body.files || [] }) };
    } else {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: result.body?.error?.message || 'Search failed' }) };
    }
  }

  // ── READ FILE CONTENT ──
  if (action === 'read') {
    if (!fileId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'fileId required' }) };

    let path;
    // Google Docs need to be exported as plain text
    if (mimeType === 'application/vnd.google-apps.document') {
      path = `/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`;
    } else {
      // Download raw content for other text files
      path = `/drive/v3/files/${fileId}?alt=media`;
    }

    const result = await httpsRequest({
      hostname: 'www.googleapis.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (result.status === 200) {
      const content = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
      // Truncate to 6000 chars to stay within context limits
      const truncated = content.length > 6000 ? content.slice(0, 6000) + '\n\n[Content truncated at 6000 chars]' : content;
      return { statusCode: 200, headers, body: JSON.stringify({ content: truncated }) };
    } else {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: 'Could not read file' }) };
    }
  }

  // ── LIST RECENT ──
  if (action === 'recent') {
    const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink)');
    const path = `/drive/v3/files?fields=${fields}&pageSize=10&orderBy=modifiedTime+desc&q=trashed+%3D+false`;

    const result = await httpsRequest({
      hostname: 'www.googleapis.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (result.status === 200) {
      return { statusCode: 200, headers, body: JSON.stringify({ files: result.body.files || [] }) };
    } else {
      return { statusCode: result.status, headers, body: JSON.stringify({ error: result.body?.error?.message || 'Failed to list files' }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};
