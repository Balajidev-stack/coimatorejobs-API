import mongoose from 'mongoose';

// ---------------------------------------------------------------------------
// Audit trail for Google Indexing API notifications.
//
// One document per (url, type) pair: a job that is edited ten times keeps a
// single URL_UPDATED row whose `attempts` counter climbs, rather than ten rows.
// That keeps the collection proportional to the number of live jobs instead of
// the number of edits, and makes "when was this URL last accepted by Google?"
// a single-document lookup.
//
// Credentials are never written here. The only Google-supplied data stored is
// the HTTP status and the error/response body, which contain no secrets.
// ---------------------------------------------------------------------------

export const INDEXING_TYPES = ['URL_UPDATED', 'URL_DELETED'];
export const INDEXING_STATUSES = ['pending', 'success', 'failed', 'skipped', 'dry-run'];

const indexingLogSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: INDEXING_TYPES,
      required: true,
    },
    // 'skipped' covers disabled/misconfigured runs; 'dry-run' records what
    // would have been sent so a dry-run deploy still produces an audit trail.
    status: {
      type: String,
      enum: INDEXING_STATUSES,
      default: 'pending',
      index: true,
    },
    httpStatus: {
      type: Number,
      default: null,
    },
    // Google's response or error body, truncated before it reaches the schema.
    googleResponse: {
      type: String,
      default: '',
    },
    errorMessage: {
      type: String,
      default: '',
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastAttemptAt: {
      type: Date,
      default: null,
    },
    lastSuccessAt: {
      type: Date,
      default: null,
    },
    // The job this URL belongs to, when the caller knew it. Nullable so the
    // sweep and manual re-index can both write rows without a lookup.
    jobPost: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobPost',
      default: null,
    },
    // What caused the submission: 'create' | 'update' | 'delete' | 'expiry' |
    // 'manual' | 'auto-close' | 'auto-reopen' | 'account-delete' | 'slug-migration' |
    // 'bulk-upload' | 'approval'
    source: {
      type: String,
      default: 'unknown',
    },
  },
  { timestamps: true }
);

// The upsert key. Unique so concurrent job saves cannot race two rows into
// existence for the same notification.
indexingLogSchema.index({ url: 1, type: 1 }, { unique: true });

// Supports the status endpoint's "most recent attempt" and failure counts.
indexingLogSchema.index({ lastAttemptAt: -1 });
indexingLogSchema.index({ jobPost: 1, type: 1 });

const IndexingLog = mongoose.model('IndexingLog', indexingLogSchema);

export default IndexingLog;
