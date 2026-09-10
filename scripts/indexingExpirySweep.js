// ---------------------------------------------------------------------------
// CLI entry point for the indexing expiry sweep.
//
//   npm run indexing:sweep-expired            # default batch of 50
//   npm run indexing:sweep-expired -- --limit=20
//
// Intended to be driven by an external scheduler (Render Cron Job, host cron)
// once a day. Respects GOOGLE_INDEXING_ENABLED and GOOGLE_INDEXING_DRY_RUN like
// every other caller, so a dry-run cron reports what it would withdraw without
// contacting Google.
// ---------------------------------------------------------------------------
import mongoose from 'mongoose';

import '../config/env.js';
import connectToDatabase from '../database/mongodb.js';
import { sweepExpiredJobs } from '../utils/indexingExpirySweep.js';

const parseLimit = () => {
  const arg = process.argv.find((value) => value.startsWith('--limit='));
  const parsed = arg ? Number(arg.split('=')[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
};

const main = async () => {
  await connectToDatabase();
  const summary = await sweepExpiredJobs({ limit: parseLimit() });

  console.log('\nExpiry sweep summary');
  console.log('--------------------');
  console.log(`Scanned           : ${summary.scanned}`);
  console.log(`Already withdrawn : ${summary.alreadyWithdrawn}`);
  console.log(`Submitted         : ${summary.submitted}`);
  console.log(`Succeeded         : ${summary.succeeded}`);
  console.log(`Failed            : ${summary.failed}`);
  console.log(`Skipped           : ${summary.skipped}`);

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error('Expiry sweep failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch {
    // Disconnect failures during teardown are not actionable.
  }
  process.exitCode = 1;
});
