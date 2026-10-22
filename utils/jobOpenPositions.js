// utils/jobOpenPositions.js
// ---------------------------------------------------------------------------
// "Positions still open" — the third condition of a LIVE job, next to
// status: 'Published' and applicationDeadline >= now.
//
// A job whose positions are all filled (positions.remaining <= 0) renders
// "Applications Closed", is noindex and carries no JobPosting on the frontend
// (cisprotraining/utils/jobAvailability.js). Listing, counting, advertising it
// in the sitemap or announcing it to Google as live contradicted that page.
//
// Jobs without a positions sub-document (legacy rows) stay open, exactly as the
// frontend treats them. Read-only: nothing here writes to a job.
// ---------------------------------------------------------------------------

/** Mongo clause: positions not exhausted (or not tracked). */
export const OPEN_POSITIONS_CLAUSE = Object.freeze({
  $or: [
    { 'positions.remaining': { $gt: 0 } },
    { 'positions.remaining': { $exists: false } },
    { 'positions.remaining': null },
  ],
});

/** Adds the clause to a filter without clobbering an existing $or / $and. */
export const withOpenPositions = (filter = {}) => ({
  ...filter,
  $and: [...(Array.isArray(filter.$and) ? filter.$and : []), OPEN_POSITIONS_CLAUSE],
});

/** In-memory twin of the clause, for documents already loaded. */
export const hasOpenPositions = (job) => {
  const remaining = job?.positions?.remaining;
  if (remaining === null || remaining === undefined || remaining === '') return true;
  const value = Number(remaining);
  return !Number.isFinite(value) || value > 0;
};
