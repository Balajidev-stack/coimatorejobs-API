// ---------------------------------------------------------------------------
// CLI entry point for the live-job indexing backfill.
//
//   npm run indexing:backfill-live -- --dry-run      # list what would be sent
//   npm run indexing:backfill-live                   # send (default 100)
//   npm run indexing:backfill-live -- --limit=50
//   npm run indexing:backfill-live -- --exclude=slug-one,slug-two   # e.g. test jobs
//
// Sends URL_UPDATED for live /job/{slug} pages that Google has not yet been
// told about since their last update. Respects GOOGLE_INDEXING_ENABLED and
// GOOGLE_INDEXING_DRY_RUN like every other caller. Run it where the production
// environment variables live (e.g. a Render shell / one-off job).
// ---------------------------------------------------------------------------
import mongoose from 'mongoose';

import '../config/env.js';
import connectToDatabase from '../database/mongodb.js';
import { describeIndexingConfig } from '../utils/googleIndexing.js';
import { MAX_BACKFILL_LIMIT, backfillLiveJobs } from '../utils/indexingLiveBackfill.js';

const parseLimit = () => {
  const arg = process.argv.find((value) => value.startsWith('--limit='));
  const parsed = arg ? Number(arg.split('=')[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_BACKFILL_LIMIT) : 100;
};

const parseExclude = () => {
  const arg = process.argv.find((value) => value.startsWith('--exclude='));
  return arg ? arg.split('=')[1].split(',').map((slug) => slug.trim()).filter(Boolean) : [];
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const config = describeIndexingConfig();
  console.log(`Indexing config: ${JSON.stringify(config)}`);

  await connectToDatabase();
  const summary = await backfillLiveJobs({ limit: parseLimit(), dryRun, excludeSlugs: parseExclude() });

  console.log('\nLive-job backfill summary');
  console.log('-------------------------');
  console.log(`Mode              : ${dryRun ? 'DRY RUN (nothing sent)' : 'SEND'}`);
  console.log(`Scanned           : ${summary.scanned}`);
  console.log(`Already announced : ${summary.alreadyAnnounced}`);
  console.log(`Not live          : ${summary.notLive}`);
  console.log(`Excluded          : ${summary.excluded}`);
  console.log(`To announce       : ${summary.pending.length}`);
  console.log(`Submitted         : ${summary.submitted}`);
  console.log(`Succeeded         : ${summary.succeeded}`);
  console.log(`Failed            : ${summary.failed}`);
  console.log(`Skipped           : ${summary.skipped}`);
  if (dryRun) summary.pending.forEach((url) => console.log(`  ${url}`));
  summary.results.filter((row) => row.status !== 'success').forEach((row) =>
    console.log(`  ${row.status} ${row.httpStatus ?? ''} ${row.url}`));

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error('Live-job backfill failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch {
    // Disconnect failures during teardown are not actionable.
  }
  process.exitCode = 1;
});
