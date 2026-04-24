// Handles Google OAuth login redirect
exports.handler = async (event) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = 'https://anisa-ai-00.netlify.app/auth/callback';
  
  const scopes = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose'
  ].join(' ');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `access_type=offline&` +
    `prompt=consent`;

  return {
    statusCode: 302,
    headers: { Location: authUrl },
    body: ''
  };
};
