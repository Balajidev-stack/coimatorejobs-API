// ---------------------------------------------------------------------------
// GET /api/v1/candidate-dashboard/jobs/hub
//
// Internal-linking summary for the /jobs-in-coimbatore SEO hub: the live job
// count for the city and the categories, roles and other locations that
// currently have live openings. It returns NO job listings — the hub has a
// single listing, served by the query engine (GET /candidate-dashboard/jobs).
//
// One projected query loads the live job set; utils/jobHubSummary.js tallies
// it. The result is cached in-process for a short TTL, since the hub renders
// on every request and taxonomy counts change on the scale of minutes.
// ---------------------------------------------------------------------------
import JobPost from '../models/jobs.model.js';
import {
  DEFAULT_HUB_CITY,
  DEFAULT_LINK_LIMIT,
  buildHubSummary,
  compactText,
} from '../utils/jobHubSummary.js';

const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 20;
const MAX_CITY_LENGTH = 60;

/** Default loader: every live job, only the fields the summary needs. */
const loadLiveJobs = (now) =>
  JobPost.find({ status: 'Published', applicationDeadline: { $gte: now } })
    .select('_id status applicationDeadline location industry role')
    .populate('industry', 'name')
    .populate('role', 'name')
    .lean();

const normalizeCity = (value) => {
  const raw = String(Array.isArray(value) ? value[0] : value ?? '').trim().slice(0, MAX_CITY_LENGTH);
  return raw || DEFAULT_HUB_CITY;
};

/** Factory so tests can inject the loader and clock without Mongo. */
export const createJobHubController = ({
  loadJobs = loadLiveJobs,
  clock = () => new Date(),
  ttlMs = CACHE_TTL_MS,
} = {}) => {
  const cache = new Map();

  const getHubSummary = async (req, res, next) => {
    try {
      const city = normalizeCity(req.query?.city);
      const limit = Number.parseInt(req.query?.limit, 10) || DEFAULT_LINK_LIMIT;
      const key = `${compactText(city)}:${limit}`;
      const now = clock();

      const cached = cache.get(key);
      if (cached && now.getTime() - cached.at < ttlMs) {
        return res.status(200).json(cached.body);
      }

      const jobs = await loadJobs(now);
      // Stable display capitalisation ("coimbatore" -> "Coimbatore").
      const displayCity = city.charAt(0).toUpperCase() + city.slice(1);
      const body = { success: true, ...buildHubSummary(jobs, { now, city: displayCity, limit }) };

      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now.getTime(), body });

      return res.status(200).json(body);
    } catch (error) {
      return next(error);
    }
  };

  return { getHubSummary, clearCache: () => cache.clear() };
};

const jobHubController = createJobHubController();

export default jobHubController;
