// tests/helpers/controllerTestEnv.js
// ---------------------------------------------------------------------------
// Inert environment for controller-level tests. Import it FIRST, before any
// controller or model: config/env.js (loaded by every controller) never
// overrides a variable that already exists, so the values pinned here win over
// any local .env file.
//
//  * NODE_ENV=production makes config/env.js look only for
//    .env.production.local, which is never committed, so developer .env secrets
//    are not loaded into the test process.
//  * Every credential a controller path could reach is pinned to an inert value
//    anyway: SMTP points at a closed local port, Firebase has no credentials,
//    and Google Indexing runs in dry-run mode with fake credentials. The tests
//    additionally replace the indexing service's submit method, so no request
//    can reach Google.
//  * Mongoose command buffering is disabled, so any query a test forgot to stub
//    fails immediately instead of waiting for a connection that never opens.
// ---------------------------------------------------------------------------
import mongoose from 'mongoose';

Object.assign(process.env, {
  NODE_ENV: 'production',
  DB_URI: 'mongodb://127.0.0.1:9/controller-tests-never-connected',
  FRONTEND_URL: 'https://coimbatorejobs.in',
  SUPERADMIN_EMAIL: '',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '9',
  SMTP_USERNAME: 'controller-tests',
  SMTP_PASSWORD: 'controller-tests',
  EMAIL_USER: 'controller-tests@example.invalid',
  EMAIL_PASS: 'controller-tests',
  AWS_ACCESS_KEY_ID: 'controller-tests',
  AWS_SECRET_ACCESS_KEY: 'controller-tests',
  FIREBASE_SERVICE_ACCOUNT_PATH: '',
  FIREBASE_CLIENT_EMAIL: '',
  FIREBASE_PRIVATE_KEY: '',
  GOOGLE_INDEXING_ENABLED: 'true',
  GOOGLE_INDEXING_DRY_RUN: 'true',
  GOOGLE_INDEXING_CLIENT_EMAIL: 'controller-tests@example.invalid',
  GOOGLE_INDEXING_PRIVATE_KEY: 'not-a-real-private-key',
  GOOGLE_INDEXING_PROJECT_ID: 'controller-tests',
  GOOGLE_INDEXING_SITE_URL: 'https://coimbatorejobs.in',
});

mongoose.set('bufferCommands', false);
