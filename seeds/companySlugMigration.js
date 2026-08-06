// seeds/companySlugMigration.js
// ---------------------------------------------------------------------------
// Backfills CompanyProfile.slug for the public company jobs landing page
// (/jobs/company/{slug}).
//
// Slugs come from utils/jobSlug.js -> normalizeCompanyName, the SAME function
// that produced the company segment of every existing job slug. That keeps
// company URLs consistent with the company part already baked into job URLs.
// Do not re-implement the slug logic here.
//
// SAFETY:
//   * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
//   * Writes ONLY `slug`. companyName and every other field are untouched.
//   * NEVER regenerates an existing slug. Once a company URL is published it is
//     permanent — the same immutability rule job slugs follow.
//   * Uses updateOne with $set, so no model hook fires.
//   * Idempotent: a second run reports 0 changes.
//
// Collisions are resolved deterministically by processing oldest-first and
// appending -2, -3, ... so re-running assigns the same suffix to the same
// company.
//
// Usage:
//   npm run migrate:company-slugs              # dry run
//   npm run migrate:company-slugs -- --apply   # real run
//   node seeds/companySlugMigration.js --apply --verbose
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectToDatabase from '../database/mongodb.js';
import CompanyProfile from '../models/companyProfile.model.js';
import JobPost from '../models/jobs.model.js';
import { normalizeCompanyName } from '../utils/jobSlug.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

const BATCH_SIZE = 500;
const line = (char = '-') => console.log(char.repeat(78));

const migrateCompanySlugs = async () => {
  dotenv.config();
  await connectToDatabase();

  line('=');
  console.log(
    `Company slug migration — ${APPLY ? 'REAL RUN (writes enabled)' : 'DRY RUN (no writes)'}`,
  );
  console.log('Target: CompanyProfile.slug, derived from companyName');
  line('=');

  // Oldest first so collision suffixes are assigned deterministically.
  const companies = await CompanyProfile.find({})
    .select('_id companyName slug status allowInSearch createdAt')
    .sort({ createdAt: 1 })
    .lean();

  // Which companies actually have a published job. Reported (not enforced) so
  // you can see how many slugs would back a real landing page — the route
  // itself gates on this, so a slug for a company with no live jobs is inert.
  const publishedCompanyIds = new Set(
    (await JobPost.distinct('companyProfile', { status: 'Published' })).map(String),
  );

  const claimed = new Set(
    companies.map((company) => company.slug).filter(Boolean),
  );

  let generated = 0;
  let alreadyHadSlug = 0;
  let unslugifiable = 0;
  let collisions = 0;
  let withPublishedJobs = 0;
  let written = 0;
  let pending = [];

  const flush = async () => {
    if (!APPLY || !pending.length) {
      pending = [];
      return;
    }
    await CompanyProfile.bulkWrite(pending, { ordered: false });
    written += pending.length;
    pending = [];
  };

  for (const company of companies) {
    // Rule: never regenerate. Published URLs are permanent.
    if (company.slug) {
      alreadyHadSlug += 1;
      continue;
    }

    const base = normalizeCompanyName(company.companyName);
    if (!base) {
      unslugifiable += 1;
      console.warn(`  [skip] ${company._id} has no slugifiable companyName: "${company.companyName}"`);
      continue;
    }

    let candidate = base;
    let suffix = 2;
    while (claimed.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    if (candidate !== base) collisions += 1;

    claimed.add(candidate);
    generated += 1;
    if (publishedCompanyIds.has(String(company._id))) withPublishedJobs += 1;

    if (VERBOSE) {
      console.log(`  ${company._id}  "${company.companyName}"  ->  ${candidate}`);
    }

    pending.push({
      updateOne: {
        filter: { _id: company._id },
        update: { $set: { slug: candidate } },
      },
    });

    if (pending.length >= BATCH_SIZE) await flush();
  }

  await flush();

  const total = companies.length;
  const coverage =
    total === 0 ? 0 : Math.round(((generated + alreadyHadSlug) / total) * 10000) / 100;

  line('=');
  console.log(`Total company profiles     : ${total}`);
  console.log(`Already had a slug (kept)  : ${alreadyHadSlug}`);
  console.log(`Slugs generated            : ${generated}`);
  console.log(`  ...with a published job  : ${withPublishedJobs}`);
  console.log(`Collisions suffixed        : ${collisions}`);
  console.log(`Unslugifiable (skipped)    : ${unslugifiable}`);
  console.log(`COVERAGE                   : ${coverage}%`);
  console.log(`Documents written          : ${APPLY ? written : 0}${APPLY ? '' : '  (dry run)'}`);
  line('=');

  if (collisions === 0 && unslugifiable === 0) {
    console.log('No collisions and nothing unslugifiable — safe to tighten');
    console.log('CompanyProfile.slug to a unique index in a follow-up change.');
  } else if (collisions > 0) {
    console.log(`${collisions} collision(s) were suffixed. Review them before making`);
    console.log('the slug index unique.');
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to persist.');
  }

  await mongoose.connection.close();
};

migrateCompanySlugs()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Company slug migration failed:', error);
    process.exit(1);
  });
