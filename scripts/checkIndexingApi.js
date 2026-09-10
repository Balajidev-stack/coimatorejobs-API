/**
 * Standalone health check for the Google Indexing API.
 *
 * Usage:
 *   node scripts/checkIndexingApi.js [url]
 *
 * Requires a service account key. Provide it either as:
 *   GOOGLE_INDEXING_KEY_FILE=/path/to/key.json      (path to the downloaded JSON)
 * or as inline credentials:
 *   GOOGLE_INDEXING_CLIENT_EMAIL=...@...iam.gserviceaccount.com
 *   GOOGLE_INDEXING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
 *
 * The service account must be added as an Owner of the property in Google
 * Search Console, and the Indexing API must be enabled on its GCP project.
 */
import fs from 'fs';
import { JWT } from 'google-auth-library';
import '../config/env.js';

const SCOPE = 'https://www.googleapis.com/auth/indexing';
const ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications/metadata';

function loadCredentials() {
  const keyFile = process.env.GOOGLE_INDEXING_KEY_FILE;
  if (keyFile) {
    if (!fs.existsSync(keyFile)) throw new Error(`Key file not found: ${keyFile}`);
    const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    return { email: key.client_email, privateKey: key.private_key };
  }
  const email = process.env.GOOGLE_INDEXING_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_INDEXING_PRIVATE_KEY;
  if (email && privateKey) return { email, privateKey: privateKey.replace(/\n/g, '\n') };
  throw new Error(
    'No service account credentials. Set GOOGLE_INDEXING_KEY_FILE, or ' +
    'GOOGLE_INDEXING_CLIENT_EMAIL + GOOGLE_INDEXING_PRIVATE_KEY.'
  );
}

async function main() {
  const url = process.argv[2] || `${(process.env.FRONTEND_URL || 'https://coimbatorejobs.in/').replace(/\/$/, '')}/`;
  const { email, privateKey } = loadCredentials();
  console.log(`Service account : ${email}`);
  console.log(`Checking URL    : ${url}\n`);

  const client = new JWT({ email, key: privateKey, scopes: [SCOPE] });

  console.log('1. Requesting access token...');
  const token = await client.authorize();
  console.log(`   OK - token acquired (expires ${new Date(token.expiry_date).toISOString()})\n`);

  console.log('2. Calling urlNotifications/metadata...');
  const res = await client.request({
    url: `${ENDPOINT}?url=${encodeURIComponent(url)}`,
    method: 'GET',
    validateStatus: () => true,
  });

  console.log(`   HTTP ${res.status}`);
  console.log(`   ${JSON.stringify(res.data, null, 2)}\n`);

  if (res.status === 200) {
    console.log('RESULT: Indexing API is working and this URL has been submitted before.');
  } else if (res.status === 404) {
    console.log('RESULT: Indexing API is working (auth + ownership OK). This URL has just never been submitted yet.');
  } else if (res.status === 403) {
    console.log('RESULT: Auth works, but access denied. Either the Indexing API is not enabled on the GCP project, or the service account is not an Owner of the property in Search Console.');
    process.exitCode = 1;
  } else {
    console.log('RESULT: Unexpected response - see the body above.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exitCode = 1;
});
