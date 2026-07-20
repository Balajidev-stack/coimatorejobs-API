// seeds/companyLogoAudit.js
// Audits CompanyProfile.logo values for SEO / Google JobPosting readiness.
//
// Default: DRY-RUN — reports only, makes NO database changes.
//   node seeds/companyLogoAudit.js
//
// Optional fix mode — upgrades http:// -> https:// ONLY when the exact same
// URL is actually reachable over HTTPS (verified with a live HEAD request):
//   node seeds/companyLogoAudit.js --fix
//
// Safety guarantees:
//   - Never fabricates a logo, never guesses missing logos.
//   - Never rewrites relative/unknown paths.
//   - Only http->https upgrades that pass a live HTTPS reachability check.
//   - Idempotent: fixed rows become valid HTTPS and are skipped on re-runs.
import https from 'https';
import dotenv from 'dotenv';
import connectToDatabase from '../database/mongodb.js';
import CompanyProfile from '../models/companyProfile.model.js';

const FIX = process.argv.includes('--fix');

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|heic|heif|tiff?|bmp|svg)$/i;
const NON_IMAGE_EXT = /\.(pdf|html?|json|txt|exe|zip|mp4|mov|doc|docx)$/i;

// Classify a single logo value into one audit category.
const classify = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 'empty';
  }
  const trimmed = String(value).trim();

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    // Not an absolute URL — treat leading-slash / scheme-less as relative.
    if (trimmed.startsWith('/') || !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      return 'relative';
    }
    return 'invalid';
  }

  if (url.protocol === 'http:') return 'http';
  if (url.protocol !== 'https:') return 'invalid';

  // HTTPS: flag only clearly non-image extensions; extension-less CDN URLs are OK.
  if (NON_IMAGE_EXT.test(url.pathname) && !IMAGE_EXT.test(url.pathname)) {
    return 'invalidImage';
  }
  return 'valid';
};

// Verify the same URL is reachable over HTTPS (used only in --fix mode).
const supportsHttps = (urlString) =>
  new Promise((resolve) => {
    try {
      const req = https.request(
        urlString,
        { method: 'HEAD', timeout: 8000 },
        (res) => {
          res.resume();
          resolve(Boolean(res.statusCode) && res.statusCode < 400);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });

const runAudit = async () => {
  dotenv.config();
  await connectToDatabase();

  const profiles = await CompanyProfile.find({}).select('_id companyName logo');

  const buckets = {
    valid: [],
    relative: [],
    http: [],
    empty: [],
    invalid: [],
    invalidImage: [],
  };

  for (const profile of profiles) {
    buckets[classify(profile.logo)].push(profile);
  }

  console.log(`\n=== CompanyProfile.logo audit (${FIX ? 'FIX' : 'DRY-RUN'}) ===`);
  console.log(`Scanned:            ${profiles.length}`);
  console.log(`Valid HTTPS:        ${buckets.valid.length}`);
  console.log(`Relative URLs:      ${buckets.relative.length}`);
  console.log(`http:// URLs:       ${buckets.http.length}`);
  console.log(`Empty/none:         ${buckets.empty.length}`);
  console.log(`Non-image HTTPS:    ${buckets.invalidImage.length}`);
  console.log(`Invalid/malformed:  ${buckets.invalid.length}`);

  const listSample = (label, items) => {
    if (items.length === 0) return;
    console.log(`\n-- ${label} --`);
    items.slice(0, 25).forEach((p) =>
      console.log(`  ${p._id} | ${p.companyName} | ${p.logo ?? '(none)'}`)
    );
    if (items.length > 25) console.log(`  ...and ${items.length - 25} more`);
  };

  listSample('Relative URLs (manual review — NOT auto-fixed)', buckets.relative);
  listSample('http:// URLs (fixable if HTTPS reachable)', buckets.http);
  listSample('Non-image HTTPS (manual review)', buckets.invalidImage);
  listSample('Invalid/malformed (manual review)', buckets.invalid);

  if (!FIX) {
    console.log('\nDry-run complete. No database changes were made.');
    console.log('Re-run with --fix to upgrade http:// -> https:// where reachable.\n');
    process.exit();
  }

  // --fix: only upgrade http:// -> https:// when the HTTPS variant is reachable.
  let fixed = 0;
  let skipped = 0;

  for (const profile of buckets.http) {
    const httpsUrl = String(profile.logo).trim().replace(/^http:\/\//i, 'https://');
    const reachable = await supportsHttps(httpsUrl);

    if (!reachable) {
      skipped += 1;
      console.log(`SKIP (no HTTPS): ${profile._id} | ${profile.logo}`);
      continue;
    }

    await CompanyProfile.updateOne({ _id: profile._id }, { $set: { logo: httpsUrl } });
    fixed += 1;
    console.log(`FIXED: ${profile._id} | ${profile.logo} -> ${httpsUrl}`);
  }

  console.log(`\nFix complete. Upgraded: ${fixed}, skipped: ${skipped}.`);
  console.log('Relative/invalid values were intentionally left untouched.\n');
  process.exit();
};

runAudit().catch((err) => {
  console.error('Company logo audit failed:', err);
  process.exit(1);
});
