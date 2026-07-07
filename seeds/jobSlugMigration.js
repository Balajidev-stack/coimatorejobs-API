// seeds/jobSlugMigration.js
// One-off migration: recompute JobPost.slug from the old "title-city-objectId"
// format to the new "title-company-city" format (falls back to "title-city"
// when the job's company profile / name is unavailable).
import dotenv from 'dotenv';
import connectToDatabase from '../database/mongodb.js';
import JobPost from '../models/jobs.model.js';
import CompanyProfile from '../models/companyProfile.model.js';

const slugifyPart = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const buildBaseSlug = (title, companyName, cities) => {
  const titleSlug = slugifyPart(title);
  const companySlug = slugifyPart(companyName);

  let citySlug = 'india';
  if (Array.isArray(cities) && cities.length > 0) {
    citySlug = slugifyPart(cities.join('-'));
  } else if (typeof cities === 'string') {
    citySlug = slugifyPart(cities);
  }

  return [titleSlug, companySlug, citySlug].filter(Boolean).join('-');
};

const migrateJobSlugs = async () => {
  dotenv.config();
  await connectToDatabase();

  // Process oldest first so uniqueness suffixes (-2, -3, ...) are stable across re-runs.
  const jobs = await JobPost.find({}).sort({ createdAt: 1 });
  const companyNameCache = new Map();
  const usedSlugs = new Set();

  let updated = 0;
  let skipped = 0;

  for (const job of jobs) {
    const companyId = job.companyProfile?.toString();
    let companyName = companyId ? companyNameCache.get(companyId) : null;

    if (companyId && companyName === undefined) {
      const company = await CompanyProfile.findById(companyId).select('companyName');
      companyName = company?.companyName || null;
      companyNameCache.set(companyId, companyName);
    }

    const baseSlug = buildBaseSlug(job.title, companyName, job.location?.city);

    let candidate = baseSlug;
    let index = 2;
    while (usedSlugs.has(candidate)) {
      candidate = `${baseSlug}-${index}`;
      index += 1;
    }
    usedSlugs.add(candidate);

    if (job.slug === candidate) {
      skipped += 1;
      continue;
    }

    await JobPost.updateOne({ _id: job._id }, { $set: { slug: candidate } });
    updated += 1;
    console.log(`Updated job ${job._id}: "${job.slug}" -> "${candidate}"`);
  }

  console.log(`Migration completed. Updated: ${updated}, unchanged: ${skipped}, total: ${jobs.length}`);
  process.exit();
};

migrateJobSlugs().catch((err) => {
  console.error('Job slug migration failed:', err);
  process.exit(1);
});
