// indexing.routes.js
// Admin-only controls for the Google Indexing API integration. Both routes sit
// behind the existing authenticate + platform-admin authorization pair, so
// neither is reachable by employers or candidates.
import { Router } from 'express';

import indexingController from '../controller/indexing.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const indexingRouter = Router();

// Manually resubmit one job. Takes a jobId, never a URL.
indexingRouter.post(
  '/reindex',
  authenticate,
  authorize(['hr-admin', 'superadmin']),
  indexingController.reindexJob
);

// Read-only diagnostics: flags, credential presence, and attempt statistics.
indexingRouter.get(
  '/status',
  authenticate,
  authorize(['hr-admin', 'superadmin']),
  indexingController.getIndexingStatus
);

export default indexingRouter;
