import { Router } from 'express';
import employerController from '../controller/employer.controller.js';
import employerApplicantsController from '../controller/employerApplicants.controller.js';
import resumeAlertController from '../controller/resumeAlert.controller.js';
import jobsController from '../controller/jobs.controller.js';
import employerDashboardController from '../controller/employerDashboard.controller.js';
import hrAdminDashboardController from '../controller/hrAdminDashboard.controller.js';
import paymentPlanController from '../controller/paymentPlan.controller.js';
import { authenticate, authorize, authorizeEmployerLike, optionalAuthenticate } from '../middleware/auth.js';
import companyUpload from '../utils/fileUpload.js';  
import normalizeBody from '../utils/normalizeBody.js';
import Role from '../models/role.model.js';
import Location from '../models/location.model.js';
import Skill from '../models/skill.model.js';
import FunctionalArea from '../models/functionalArea.model.js';
import Industry from '../models/industry.model.js';
import trackView from '../middleware/trackView.js';
import trackJobView from '../middleware/trackJobView.js';

const employerRouter = Router();

employerRouter.get('/active-payment-plans', authenticate, authorize(['employer']), paymentPlanController.getActivePaymentPlans);
employerRouter.get('/my-payment-plan', authenticate, authorize(['employer']), paymentPlanController.getMyPaymentPlan);
employerRouter.get('/my-plan-history', authenticate, authorize(['employer']), paymentPlanController.getMyPlanHistory);
employerRouter.get('/my-plan-history/:transactionId/receipt', authenticate, authorize(['employer']), paymentPlanController.downloadMyPlanReceipt);
employerRouter.delete('/my-plan-history/:transactionId', authenticate, authorize(['employer']), paymentPlanController.deleteMyPlanHistoryTransaction);
employerRouter.post('/payment-plans/:id/razorpay-order', authenticate, authorize(['employer']), paymentPlanController.createPaymentOrder);
employerRouter.post('/payment-plans/razorpay-verify', authenticate, authorize(['employer']), paymentPlanController.verifyPayment);
employerRouter.post('/payment-plans/razorpay-failed', authenticate, authorize(['employer']), paymentPlanController.markPaymentFailed);
employerRouter.get('/payment-plans', authenticate, authorize(['superadmin']), paymentPlanController.getPaymentPlans);
employerRouter.get('/payment-plan-employers', authenticate, authorize(['superadmin']), paymentPlanController.getEmployerPlanOverview);
employerRouter.patch('/payment-plan-employers/:employerId/remove-plan', authenticate, authorize(['superadmin']), paymentPlanController.removeEmployerPaymentPlan);
employerRouter.get('/payment-plan-employers/:employerId/usage', authenticate, authorize(['superadmin']), paymentPlanController.getEmployerPlanUsage);
employerRouter.post('/payment-plans', authenticate, authorize(['superadmin']), paymentPlanController.createPaymentPlan);
employerRouter.put('/payment-plans/:id', authenticate, authorize(['superadmin']), paymentPlanController.updatePaymentPlan);
employerRouter.patch('/payment-plans/:id/status', authenticate, authorize(['superadmin']), paymentPlanController.updatePaymentPlanStatus);
employerRouter.delete('/payment-plans/:id', authenticate, authorize(['superadmin']), paymentPlanController.deletePaymentPlan);


// Route to get all company profiles (accessible to admins and superadmins)
employerRouter.get('/company-profile/fetch-all',  employerController.getAllCompanyProfiles);
// Route to create a company profile
// Only authenticated employers can access this route
// Create company profile (with file upload)
employerRouter.post('/company-profile/create',authenticate,authorizeEmployerLike(),companyUpload,employerController.createCompanyProfile);
// Update company profile (with file upload)
employerRouter.put( '/company-profile/update/:id',authenticate,authorizeEmployerLike(), companyUpload,employerController.updateCompanyProfile);
// Get company profile
employerRouter.get('/company-profile/get/:id', authenticate, authorize(['employer', 'hr-admin', 'superadmin', 'candidate']), trackView, employerController.getCompanyProfile);

// Get company profiles for logged-in employer
employerRouter.get('/company-profile/my-profiles', authenticate, authorize(['employer']), employerController.getCompanyProfilesForEmployer);

// Give approval to company profile
employerRouter.put( '/company-profile/approve/:id', authenticate, authorizeEmployerLike(),employerController.approveCompanyProfile);

// List pending company profiles
employerRouter.get('/company-profile/pending', authenticate, authorize(['hr-admin', 'superadmin']), employerController.getPendingCompanyProfiles);

// Delete company profile
employerRouter.delete('/company-profile/delete/:id',authenticate,authorizeEmployerLike(),employerController.deleteCompanyProfile);

// hr-admin / superadmin only
employerRouter.get('/company-profile/assigned', authenticate, authorize(['hr-admin', 'superadmin']), employerController.getAssignedCompanyProfiles);


// post job

// Route to create a job post (accessible to employers, admins, and superadmins)
employerRouter.post('/jobs/create', authenticate, authorizeEmployerLike(), companyUpload, normalizeBody, jobsController.createJobPost);  //we have added companyUpload to handle file uploads for job posts and normalizeBody to handle FormData parsing

// Get all job posts (filtered by employer for non-superadmins)
employerRouter.get('/jobs/fetch-all', authenticate, authorize(['employer', 'hr-admin', 'superadmin', 'candidate']),jobsController.getJobPosts);

// Public sitemap feed (SEO-safe minimal fields; no auth). Static path — safe from :id routes.
employerRouter.get('/jobs/sitemap', jobsController.getSitemapJobs);

// Get a single job post for editing
// employerRouter.get('/jobs/fetch/:id',authenticate, authorize(['employer', 'hr-admin', 'superadmin', 'candidate']), trackJobView, jobsController.getJobPost);

employerRouter.get('/jobs/fetch/:id', optionalAuthenticate, trackJobView, jobsController.getJobPost );  //public route to get job details and track views

// Update a job post
employerRouter.put('/jobs/update/:id',authenticate, authorizeEmployerLike(), companyUpload, normalizeBody, jobsController.updateJobPost);

// Delete a job post
employerRouter.delete('/jobs/delete/:id',authenticate, authorizeEmployerLike(),jobsController.deleteJobPost);

// Get active jobs posted by a specific employer (public)
employerRouter.get('/company/:id/jobs', employerController.getActiveJobsByEmployer);

// Get job posts created by employers themselves
employerRouter.get('/jobs/by-employers', authenticate,  authorizeEmployerLike(), jobsController.getEmployerJobPosts);

// Get job posts created by HR-Admins or Superadmins
employerRouter.get('/jobs/by-admins', authenticate, authorize(['hr-admin', 'superadmin']), jobsController.getAdminPostedJobs);


// Get applicants for a specific job post

// Get all applicants for a specific job with filters
employerRouter.get('/applicants/:jobId', authenticate, authorizeEmployerLike(), employerApplicantsController.getApplicantsByJob);

// Get all applicants across all jobs by employer
employerRouter.get('/applicants', authenticate, authorizeEmployerLike(), employerApplicantsController.getAllApplicants);

/**
 * List applicants for HR-Admin assigned employers
 */
employerRouter.get('/hr-admin/applicants', authenticate, authorize(['hr-admin', 'superadmin']), employerApplicantsController.getHrAdminEmployersApplicants);


// Update applicant status (approve/reject)
employerRouter.put('/applicants/:applicationId/status', authenticate, authorizeEmployerLike(), employerApplicantsController.updateApplicantStatus);

// Delete an application
employerRouter.delete('/applicants/delete/:applicationId', authenticate, authorizeEmployerLike(), employerApplicantsController.deleteApplicant);

// View applicant details
employerRouter.get('/applicants/get/:applicationId', authenticate, authorizeEmployerLike(), employerApplicantsController.viewApplicant);

// Resume download quota summary and controlled resume downloads
employerRouter.get('/resume-downloads/usage', authenticate, authorizeEmployerLike(), employerApplicantsController.getResumeDownloadUsage);
employerRouter.get('/applicants/:applicationId/resume', authenticate, authorizeEmployerLike(), employerApplicantsController.downloadApplicantResume);

// Bulk update applicant statuses
employerRouter.put('/applicants/bulk-status', authenticate, authorizeEmployerLike(), employerApplicantsController.bulkUpdateStatus);

// Shortlist an applicant
employerRouter.put('/applicants/:applicationId/shortlist', authenticate, authorizeEmployerLike(), employerApplicantsController.shortlistApplicant);

// Unshortlist an applicant
employerRouter.put('/applicants/:applicationId/unshortlist', authenticate, authorizeEmployerLike(), employerApplicantsController.unshortlistApplicant);

// Get shortlisted resumes
employerRouter.get('/shortlisted-resumes', authenticate, authorizeEmployerLike(), employerApplicantsController.getShortlistedResumes);

// candidate save for future use
// Save candidate profile
employerRouter.post('/saved-candidates/save/:candidateId', authenticate, authorize(['employer', 'hr-admin']), employerController.saveCandidate);

// Unsave candidate
employerRouter.delete('/saved-candidates/un-save/:savedId', authenticate, authorize(['employer', 'hr-admin']), employerController.unsaveCandidate);

// Get saved candidates (with filters)
employerRouter.get('/saved-candidates', authenticate, authorize(['employer', 'hr-admin']), employerController.getSavedCandidates);

// resume alert routes
// Create resume alert
employerRouter.post('/resume-alerts/create', authenticate, authorize(['employer']), resumeAlertController.createResumeAlert);

// Update resume alert
employerRouter.put('/resume-alerts/update/:id', authenticate, authorize(['employer']), resumeAlertController.updateResumeAlert);

// Delete resume alert
employerRouter.delete('/resume-alerts/delete/:id', authenticate, authorize(['employer']), resumeAlertController.deleteResumeAlert);

// List resume alerts
employerRouter.get('/resume-alerts/get-all', authenticate, authorize(['employer']), resumeAlertController.listResumeAlerts);

// Get matches for specific alert
employerRouter.get('/resume-alerts/:id/matches', authenticate, authorizeEmployerLike(), resumeAlertController.getAlertMatches);


// Employer dashboard routes
// Dashboard stats and analytics routes
employerRouter.get('/stats', authenticate, authorize(['employer', 'hr-admin', 'superadmin']), employerDashboardController.getDashboardStats);

// get profile views data
employerRouter.get('/profile-views', authenticate, authorize(['employer', 'hr-admin', 'superadmin']), employerDashboardController.getProfileViewsData);

// get recent activities
employerRouter.get('/recent-activities', authenticate, authorize(['employer', 'hr-admin', 'superadmin']), employerDashboardController.getRecentActivity);

// employerRouter.get('/message-stats', authenticate, authorize(['employer', 'hr-admin', 'superadmin']), 
//   employerDashboardController.getMessageStats);

// get application trends
employerRouter.get('/application-trends', authenticate, authorize(['employer', 'hr-admin', 'superadmin']), employerDashboardController.getApplicationTrends);

// get top applicants
employerRouter.get('/job-status-distribution', authenticate, authorize(['employer', 'hr-admin', 'superadmin']), employerDashboardController.getJobStatusDistribution);

/**
 * Employer-wise applicant summary
 * (HR-Admin / Superadmin only)
 */
employerRouter.get('/hr-admin/employers/applicants-summary', authenticate, authorize(['hr-admin', 'superadmin']), employerApplicantsController.getEmployerApplicantsSummary);

// HR-Admin / Superadmin Dashboard Routes
// employerRouter.get('/hr-admin/stats', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getDashboardStats);
// employerRouter.get('/hr-admin/recent-activities', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getRecentActivity);
// employerRouter.get('/hr-admin/application-trends', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getApplicationTrends);
// employerRouter.get('/hr-admin/top-employers', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getTopEmployers);


// Platform statistics overview
employerRouter.get('/hr-admin-dashboard/platform-stats', authenticate, authorize(['hr-admin', 'superadmin']),hrAdminDashboardController.getPlatformStats);

// Assigned employers overview
employerRouter.get('/hr-admin-dashboard/assigned-employers', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getAssignedEmployers);

// Job performance metrics
employerRouter.get('/hr-admin-dashboard/job-performance',  authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getJobPerformance);

// Application trends across platform
employerRouter.get('/hr-admin-dashboard/application-trends', authenticate, authorize(['hr-admin', 'superadmin']),  hrAdminDashboardController.getApplicationTrends);

// Candidate analytics
employerRouter.get( '/hr-admin-dashboard/candidate-analytics', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getCandidateAnalytics);

// Pending approvals and actions
employerRouter.get('/hr-admin-dashboard/pending-actions', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getPendingActions);

// Revenue/reporting metrics
employerRouter.get('/hr-admin-dashboard/revenue-metrics', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getRevenueMetrics);

// monthly performance report
employerRouter.get('/hr-admin-dashboard/reports/monthly-performance', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getMonthlyPerformanceReport);

//employer activity report
employerRouter.get('/hr-admin-dashboard/reports/employer-activity', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getEmployerActivityReport
);

//skill demand report
employerRouter.get('/hr-admin-dashboard/reports/skills-demand', authenticate, authorize(['hr-admin', 'superadmin']), hrAdminDashboardController.getSkillsDemandReport);


// Public / SEO routes (no auth required)
employerRouter.get('/location/:city', jobsController.getJobsByLocation);
employerRouter.get('/category/:categorySlug', jobsController.getJobsByCategory);
employerRouter.get('/role/:roleSlug', jobsController.getJobsByRole);

// HIGH VALUE SEO ROUTE
employerRouter.get('/jobs/:roleSlug-jobs-in-:city', jobsController.getJobsByRoleAndCity);

// GET /api/categories
employerRouter.get('/categories', async (req, res) => {
  const industries = await Industry.find().select('name slug');
  const functions = await FunctionalArea.find().populate('industry', 'name slug').select('name slug industry');
  const roles = await Role.find().populate('functionalArea', 'name slug').select('name slug functionalArea');
  res.json({ industries, functionalAreas: functions, roles });
});

export default employerRouter;
