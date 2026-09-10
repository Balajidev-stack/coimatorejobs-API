// seeds/jobSlugMigration.js
// ---------------------------------------------------------------------------
// Re-slugs every JobPost to the canonical format defined in utils/jobSlug.js:
//
//   {job-title}-jobs-in-{primary-city}-{company-name}
//
// It converts legacy slugs of any earlier shape, including the old
// "title-city-<ObjectId>" and interim "title-company-city" formats.
//
// SAFETY: this script is DRY RUN BY DEFAULT. Nothing is written unless --apply
// is passed. This is the ONLY place allowed to overwrite an existing slug;
// the model hooks never reformat a slug that already exists (Rule 7).
//
// Usage:
//   npm run migrate:job-slugs             # dry run: report only, no writes
//   npm run migrate:job-slugs -- --apply  # real run: writes slugs
//   node seeds/jobSlugMigration.js --apply --verbose
//
// Flags:
//   --apply     perform writes (omit for dry run)
//   --verbose   print every job's old -> new mapping (dry run prints changes
//               only by default)
//   --notify-google
//               with --apply only: report each rewritten job to the Google
//               Indexing API (URL_UPDATED for the new URL when the job is live;
//               URL_DELETED for an old URL that will now 404). Off by default
//               because a large migration can exceed the 200/day quota.
//
// Determinism: jobs are processed oldest-first, so duplicate suffixes (-2, -3)
// are assigned by creation order and stay stable across re-runs.
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import connectToDatabase from '../database/mongodb.js';
import JobPost from '../models/jobs.model.js';
import CompanyProfile from '../models/companyProfile.model.js';
import { buildJobSlugBase, buildUniqueJobSlug } from '../utils/jobSlug.js';
import {
  buildCanonicalJobUrl,
  isPubliclyIndexable,
  submitUrlDeleted,
  submitUrlUpdated,
} from '../utils/googleIndexing.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const NOTIFY_GOOGLE = args.includes('--notify-google');

// Legacy "title-city-<ObjectId>" slugs. The frontend resolves the embedded id
// and 308-redirects to the canonical URL, so those old URLs keep working.
const OBJECT_ID_SUFFIX = /(?:^|-)[a-f0-9]{24}$/i;

const line = (char = '-') => console.log(char.repeat(78));

const migrateJobSlugs = async () => {
  dotenv.config();
  await connectToDatabase();

  line('=');
  console.log(`Job slug migration — ${APPLY ? 'REAL RUN (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log('Target format: {job-title}-jobs-in-{primary-city}-{company-name}');
  line('=');

  // Oldest first so uniqueness suffixes are assigned deterministically.
  const jobs = await JobPost.find({})
    .select('_id title slug location companyProfile status applicationDeadline createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const companyNameCache = new Map();
  const resolveCompanyName = async (companyId) => {
    if (!companyId) return null;
    const key = String(companyId);
    if (companyNameCache.has(key)) return companyNameCache.get(key);

    const company = await CompanyProfile.findById(key).select('companyName').lean();
    const name = company?.companyName || null;
    companyNameCache.set(key, name);
    return name;
  };

  // Final-state slug ownership: baseSlug -> [jobIds] for the collision report,
  // and the set of slugs already claimed during this pass.
  const claimedSlugs = new Set();
  const baseSlugOwners = new Map();

  const planned = [];
  const skipped = [];

  for (const job of jobs) {
    const companyName = await resolveCompanyName(job.companyProfile);
    const baseSlug = buildJobSlugBase({
      title: job.title,
      companyName,
      city: job.location?.city,
    });

    if (!baseSlug) {
      skipped.push({ id: String(job._id), title: job.title, reason: 'no usable title' });
      continue;
    }

    // A candidate is taken if this pass already claimed it, or if a job OUTSIDE
    // this pass holds it (defensive — the pass covers every job, so in practice
    // only the in-memory set matters).
    const isSlugTaken = async (candidate) => {
      if (claimedSlugs.has(candidate)) return true;
      const holder = await JobPost.exists({ slug: candidate, _id: { $ne: job._id } });
      return Boolean(holder);
    };

    let newSlug;
    try {
      newSlug = await buildUniqueJobSlug(baseSlug, isSlugTaken);
    } catch (err) {
      skipped.push({ id: String(job._id), title: job.title, reason: err.message });
      continue;
    }

    claimedSlugs.add(newSlug);

    const owners = baseSlugOwners.get(baseSlug) || [];
    owners.push({ id: String(job._id), title: job.title, assigned: newSlug });
    baseSlugOwners.set(baseSlug, owners);

    planned.push({
      id: String(job._id),
      title: job.title,
      status: job.status,
      applicationDeadline: job.applicationDeadline,
      oldSlug: job.slug || null,
      newSlug,
      changed: job.slug !== newSlug,
    });
  }

  const changes = planned.filter((entry) => entry.changed);
  const unchanged = planned.filter((entry) => !entry.changed);

  // ---------------- COLLISION REPORT ----------------
  const collisions = [...baseSlugOwners.entries()].filter(([, owners]) => owners.length > 1);

  line();
  console.log(`COLLISION REPORT — ${collisions.length} base slug(s) claimed by more than one job`);
  line();
  if (collisions.length === 0) {
    console.log('  none — every job produced a distinct base slug');
  } else {
    for (const [baseSlug, owners] of collisions) {
      console.log(`  ${baseSlug}  (x${owners.length})`);
      owners.forEach((owner) => console.log(`      ${owner.assigned}   <- ${owner.id}  "${owner.title}"`));
    }
  }

  // ---------------- MAPPING ----------------
  const listed = VERBOSE ? planned : changes;
  if (listed.length > 0) {
    line();
    console.log(`MAPPING — ${VERBOSE ? 'all jobs' : 'changes only'} (${listed.length})`);
    line();
    listed.forEach((entry) => {
      const marker = entry.changed ? '~' : '=';
      console.log(`  ${marker} ${entry.oldSlug || '(none)'}`);
      console.log(`      -> ${entry.newSlug}`);
    });
  }

  if (skipped.length > 0) {
    line();
    console.log(`SKIPPED — ${skipped.length}`);
    line();
    skipped.forEach((entry) => console.log(`  ${entry.id}  "${entry.title}"  (${entry.reason})`));
  }

  // ---------------- WRITE PHASE ----------------
  let written = 0;
  let failed = 0;

  if (APPLY && changes.length > 0) {
    line();
    console.log(`WRITING ${changes.length} slug(s)...`);
    line();

    for (const entry of changes) {
      try {
        // updateOne bypasses the model's slug hooks by design: the hooks refuse
        // to reformat an existing slug, and reformatting is exactly the point
        // here. $set writes the slug directly and touches nothing else.
        await JobPost.updateOne({ _id: entry.id }, { $set: { slug: entry.newSlug } });
        written += 1;
        entry.written = true;
      } catch (err) {
        failed += 1;
        console.error(`  FAILED ${entry.id}: ${err.message}`);
      }
    }
  }

  // ---------------- GOOGLE INDEXING (opt-in) ----------------
  // Slugs are otherwise immutable, so this script is the only place a public
  // job URL changes. With --apply --notify-google each rewritten job is
  // reported through the existing indexing service:
  //   * new URL -> URL_UPDATED, when the job is a live public page
  //   * old URL -> URL_DELETED, when the job was Published and the old slug
  //                now 404s. Legacy "title-city-<ObjectId>" slugs still
  //                resolve and 308-redirect to the new URL, so they are left
  //                for Google to follow rather than withdrawn.
  // Sequential and awaited, so audit rows are written before the process exits.
  const google = { updated: 0, deleted: 0, failed: 0, skipped: 0 };

  if (APPLY && NOTIFY_GOOGLE) {
    const rewritten = changes.filter((entry) => entry.written);
    const tally = (result, bucket) => {
      if (result.status === 'success') google[bucket] += 1;
      else if (result.status === 'failed') google.failed += 1;
      else google.skipped += 1;
    };

    line();
    console.log(`GOOGLE INDEXING — ${rewritten.length} rewritten job(s)`);
    line();

    for (const entry of rewritten) {
      const options = { jobPost: entry.id, source: 'slug-migration' };

      if (entry.oldSlug && entry.status === 'Published' && !OBJECT_ID_SUFFIX.test(entry.oldSlug)) {
        tally(await submitUrlDeleted(buildCanonicalJobUrl({ slug: entry.oldSlug }), options), 'deleted');
      }

      const migratedJob = {
        _id: entry.id,
        slug: entry.newSlug,
        status: entry.status,
        applicationDeadline: entry.applicationDeadline,
      };
      if (isPubliclyIndexable(migratedJob)) {
        tally(await submitUrlUpdated(buildCanonicalJobUrl(migratedJob), options), 'updated');
      }
    }
  } else if (NOTIFY_GOOGLE) {
    console.log('\n--notify-google ignored: dry run (re-run with --apply --notify-google)');
  }

  // ---------------- SUMMARY REPORT ----------------
  line('=');
  console.log('SUMMARY');
  line('=');
  console.log(`  mode                : ${APPLY ? 'REAL RUN' : 'DRY RUN'}`);
  console.log(`  jobs inspected      : ${jobs.length}`);
  console.log(`  slugs planned       : ${planned.length}`);
  console.log(`  already canonical   : ${unchanged.length}`);
  console.log(`  needing change      : ${changes.length}`);
  console.log(`  duplicate suffixes  : ${changes.filter((e) => /-\d+$/.test(e.newSlug)).length}`);
  console.log(`  base collisions     : ${collisions.length}`);
  console.log(`  skipped             : ${skipped.length}`);
  if (APPLY) {
    console.log(`  written             : ${written}`);
    console.log(`  write failures      : ${failed}`);
  } else {
    console.log('  written             : 0 (dry run — re-run with --apply to write)');
  }
  line('=');

  process.exit(failed > 0 ? 1 : 0);
};

migrateJobSlugs().catch((err) => {
  console.error('Job slug migration failed:', err);
  process.exit(1);
});
