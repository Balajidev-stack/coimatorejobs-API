// utils/jobTaxonomyResolver.js
// ---------------------------------------------------------------------------
// Translates the SLUG / TEXT values that arrive on the query string into the
// ObjectIds and canonical names that JobPost actually stores.
//
// Read-only. This module never writes to any collection.
//
// Three hazards are encoded here deliberately; do not "simplify" them away:
//
//  1. Role.slug is NOT unique. The Role model carries a COMPOUND index on
//     { slug, functionalArea } (models/role.model.js), so the same role slug
//     legitimately exists under several functional areas. Resolution therefore
//     collects ALL matching ids and the filter uses $in. A findOne() here would
//     silently return a partial result set.
//
//  2. Roles are SOFT-deleted. master.controller.js deleteCustomRole sets
//     isActive:false rather than removing the document, and the master API that
//     feeds the UI filters on isActive:true. Role resolution must do the same,
//     or ?role= resurrects roles a user already deleted.
//
//  3. CompanyProfile has NO slug column. Adding one is a schema change plus a
//     backfill plus a collision policy, and is deferred to Phase 2. Until then
//     ?company= is resolved by slugifying companyName at query time over a
//     small, TTL-cached index. KNOWN LIMITATION: two companies whose names
//     slugify identically both match a single ?company= value. This is
//     documented in the API contract and disappears when the column lands.
//
// Industry, Location and Skill all have unique slugs, so their resolution is a
// direct lookup with a de-slugged name fallback for legacy values.
// ---------------------------------------------------------------------------
import Industry from '../models/industry.model.js';
import Role from '../models/role.model.js';
import Skill from '../models/skill.model.js';
import Location from '../models/location.model.js';
import CompanyProfile from '../models/companyProfile.model.js';

// How long the company name->slug index is reused within a process.
const COMPANY_CACHE_TTL_MS = 60 * 1000;

// Upper bound on how many taxonomy rows a single free-text ?q= may expand into.
// Prevents a one-letter query from turning into a several-thousand-id $in.
const TEXT_MATCH_LIMIT = 50;

const toText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return '';
};

export const escapeRegex = (value) => toText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The slug convention used across this codebase's master data
 * (master.controller.js slugifyValue), plus "&" -> "and" so that an industry
 * such as "Banking & Finance" resolves from "banking-and-finance".
 */
export const slugifyTaxonomyValue = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** "information-technology" -> "information technology" */
const deSlug = (slug) => toText(slug).split('-').filter(Boolean).join(' ');

const exactInsensitive = (value) => new RegExp(`^${escapeRegex(value)}$`, 'i');
const containsInsensitive = (value) => new RegExp(escapeRegex(value), 'i');

const emptyMatch = () => ({ ids: [], items: [], requested: '', matched: false });

const buildMatch = (requested, docs) => ({
  ids: docs.map((doc) => doc._id),
  items: docs.map((doc) => ({
    id: String(doc._id),
    name: doc.name || '',
    slug: doc.slug || '',
  })),
  requested,
  matched: docs.length > 0,
});

// ---------------------------------------------------------------------------
// INDUSTRY  (Industry.slug is unique)
// ---------------------------------------------------------------------------
const resolveIndustry = async (value) => {
  const slug = slugifyTaxonomyValue(value);
  if (!slug) return emptyMatch();

  let docs = await Industry.find({ slug }).select('_id name slug').lean();

  if (!docs.length) {
    docs = await Industry.find({ name: exactInsensitive(deSlug(slug)) })
      .select('_id name slug')
      .lean();
  }

  return buildMatch(slug, docs);
};

// ---------------------------------------------------------------------------
// ROLE  (slug NOT unique -> $in; soft-deleted roles excluded)
// ---------------------------------------------------------------------------
const resolveRole = async (value) => {
  const slug = slugifyTaxonomyValue(value);
  if (!slug) return emptyMatch();

  let docs = await Role.find({ slug, isActive: true }).select('_id name slug').lean();

  if (!docs.length) {
    docs = await Role.find({ name: exactInsensitive(deSlug(slug)), isActive: true })
      .select('_id name slug')
      .lean();
  }

  return buildMatch(slug, docs);
};

// ---------------------------------------------------------------------------
// SKILL  (Skill.slug is unique; multiple slugs accepted)
// ---------------------------------------------------------------------------
const resolveSkills = async (values) => {
  const slugs = [...new Set((values || []).map(slugifyTaxonomyValue).filter(Boolean))];
  if (!slugs.length) return emptyMatch();

  let docs = await Skill.find({ slug: { $in: slugs } }).select('_id name slug').lean();

  const foundSlugs = new Set(docs.map((doc) => doc.slug));
  const unresolved = slugs.filter((slug) => !foundSlugs.has(slug));

  if (unresolved.length) {
    const byName = await Skill.find({
      name: { $in: unresolved.map((slug) => exactInsensitive(deSlug(slug))) },
    })
      .select('_id name slug')
      .lean();

    const seen = new Set(docs.map((doc) => String(doc._id)));
    byName.forEach((doc) => {
      if (!seen.has(String(doc._id))) docs.push(doc);
    });
  }

  return buildMatch(slugs.join(','), docs);
};

// ---------------------------------------------------------------------------
// LOCATION  (resolves to the canonical CITY NAME, because JobPost stores
//            location.city as an array of plain strings, not a reference)
// ---------------------------------------------------------------------------
const resolveLocation = async (value) => {
  const slug = slugifyTaxonomyValue(value);
  if (!slug) return { name: '', slug: '', requested: '', matched: false };

  const doc = await Location.findOne({ slug }).select('_id name slug').lean();
  if (doc?.name) {
    return { name: doc.name, slug: doc.slug || slug, requested: slug, matched: true };
  }

  // Not in the master Location list. Job cities are free text, so a de-slugged
  // name is still a valid match target — fall through rather than returning
  // "no results" for a city that exists on jobs but not in master data.
  return { name: deSlug(slug), slug, requested: slug, matched: false };
};

// ---------------------------------------------------------------------------
// COMPANY  (no slug column -> query-time slugify over a TTL-cached index)
// ---------------------------------------------------------------------------
let companyIndexCache = { builtAt: 0, bySlug: new Map(), all: [] };

const getCompanyIndex = async () => {
  const now = Date.now();
  if (companyIndexCache.builtAt && now - companyIndexCache.builtAt < COMPANY_CACHE_TTL_MS) {
    return companyIndexCache;
  }

  const companies = await CompanyProfile.find({})
    .select('_id companyName')
    .lean();

  const bySlug = new Map();
  companies.forEach((company) => {
    const slug = slugifyTaxonomyValue(company.companyName);
    if (!slug) return;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({ _id: company._id, name: company.companyName, slug });
  });

  companyIndexCache = { builtAt: now, bySlug, all: companies };
  return companyIndexCache;
};

const resolveCompany = async (value) => {
  const slug = slugifyTaxonomyValue(value);
  if (!slug) return emptyMatch();

  const index = await getCompanyIndex();
  const docs = index.bySlug.get(slug) || [];
  return buildMatch(slug, docs);
};

/** Test/ops hook: drop the company cache so a rename is visible immediately. */
export const resetCompanyIndexCache = () => {
  companyIndexCache = { builtAt: 0, bySlug: new Map(), all: [] };
};

// ---------------------------------------------------------------------------
// FREE TEXT (?q=) -> taxonomy ids whose NAME contains the term.
// The job's own title/seoKeywords are matched directly in the filter; this
// resolves the reference-typed fields that a regex cannot reach.
// ---------------------------------------------------------------------------
const resolveTextTargets = async (q) => {
  const term = toText(q);
  if (!term) return { roleIds: [], industryIds: [], companyIds: [] };

  const pattern = containsInsensitive(term);

  const [roles, industries, companyIndex] = await Promise.all([
    Role.find({ name: pattern, isActive: true }).select('_id').limit(TEXT_MATCH_LIMIT).lean(),
    Industry.find({ name: pattern }).select('_id').limit(TEXT_MATCH_LIMIT).lean(),
    getCompanyIndex(),
  ]);

  const lowered = term.toLowerCase();
  const companyIds = companyIndex.all
    .filter((company) => String(company.companyName || '').toLowerCase().includes(lowered))
    .slice(0, TEXT_MATCH_LIMIT)
    .map((company) => company._id);

  return {
    roleIds: roles.map((doc) => doc._id),
    industryIds: industries.map((doc) => doc._id),
    companyIds,
  };
};

/**
 * Resolves every taxonomy-backed value on a parsed query in one pass.
 * Only the parameters actually present incur a lookup.
 *
 * @param {object} parsed  output of parseJobQuery() (utils/jobQueryFilter.js)
 * @returns {Promise<object>} resolved descriptor consumed by buildJobFilter()
 */
export const resolveJobQueryTaxonomy = async (parsed = {}) => {
  const [industry, role, company, location, skills, textTargets] = await Promise.all([
    parsed.industry ? resolveIndustry(parsed.industry) : emptyMatch(),
    parsed.role ? resolveRole(parsed.role) : emptyMatch(),
    parsed.company ? resolveCompany(parsed.company) : emptyMatch(),
    parsed.location
      ? resolveLocation(parsed.location)
      : { name: '', slug: '', requested: '', matched: false },
    parsed.skills?.length ? resolveSkills(parsed.skills) : emptyMatch(),
    parsed.q ? resolveTextTargets(parsed.q) : { roleIds: [], industryIds: [], companyIds: [] },
  ]);

  return { industry, role, company, location, skills, textTargets };
};

export default resolveJobQueryTaxonomy;
