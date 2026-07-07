import { Router } from "express";
import candidateController from "../controller/candidate.controller.js";
import candidateCvController from '../controller/candidateCv.controller.js';
import candidateResumeController from '../controller/candidateResume.controller.js';
import candidateDashboardController from '../controller/candidateDashboard.controller.js';
import notificationController from '../controller/notification.controller.js';
import { authenticate, authorize, optionalAuthenticate } from "../middleware/auth.js";
import { candidateUpload, cvUpload } from "../utils/candidateFileUpload.js"; 
import trackCandidateView from '../middleware/trackCandidateView.js';
import normalizeBody from '../utils/normalizeBody.js';

const candidateRouter = Router();

// Get candidate profiles (public-safe view for guests/candidates, full view for employer/admin roles)
candidateRouter.get('/profile/fetch-all', optionalAuthenticate, candidateController.getAllCandidateProfiles);

// Create candidate profile (with file upload)
candidateRouter.post('/profile/create', authenticate, authorize(['candidate', 'hr-admin', 'superadmin']), candidateUpload, normalizeBody, candidateController.createCandidateProfile);

// Update candidate profile (with file upload)
candidateRouter.put('/profile/update/:id', authenticate, authorize(['candidate','hr-admin', 'superadmin']), candidateUpload, normalizeBody, candidateController.updateCandidateProfile);

// Get single candidate profile
candidateRouter.get('/profile/get/:id', authenticate, authorize(['candidate', 'employer', 'hr-admin', 'superadmin']),trackCandidateView, candidateController.getCandidateProfile);

// Get candidate's own profiles (for candidate users only)
candidateRouter.get('/profile/my-profiles', authenticate, authorize(['candidate']), candidateController.getCandidateProfilesForCandidate);

// Delete candidate profile
candidateRouter.delete('/profile/delete/:id', authenticate, authorize(['candidate', 'superadmin', 'hr-admin']), candidateController.deleteCandidateProfile);

candidateRouter.get( '/candidate-profile/assigned', authenticate, authorize(['hr-admin', 'superadmin', 'hr-admin']), candidateController.getAssignedCandidateProfiles);


// Give approval to candidate profile
candidateRouter.put( '/candidate-profile/approve/:id', authenticate, authorize(['hr-admin', 'superadmin']),candidateController.approveCandidateProfile);

// List pending company profiles
candidateRouter.get('/candidate-profile/pending', authenticate, authorize(['hr-admin', 'superadmin']), candidateController.getPendingCandidateProfiles);


// View all job posts (public for guests/candidates; employer access can be plan-gated)
candidateRouter.get('/jobs', optionalAuthenticate, candidateController.getAllJobPosts);

// Apply to a job (with optional resume upload)
candidateRouter.post('/jobs/apply/:jobId', authenticate, authorize(['candidate']), candidateUpload, candidateController.applyToJob);

// Save a job
candidateRouter.post('/jobs/save/:jobId', authenticate, authorize(['candidate']), candidateController.saveJob);

// get application status
candidateRouter.get('/applications/:applicationId/status', authenticate, authorize(['candidate']), candidateController.getApplicationStatus);

// Get applied jobs dashboard
candidateRouter.get('/applied-jobs/get', authenticate, authorize(['candidate']), candidateController.getAppliedJobs);

// Get saved jobs dashboard
candidateRouter.get('/saved-jobs/get', authenticate, authorize(['candidate']), candidateController.getSavedJobs);

// Delete applied job
candidateRouter.delete('/applied-jobs/:applicationId', authenticate, authorize(['candidate']), candidateController.deleteAppliedJob);

// Delete saved job
candidateRouter.delete('/jobs/saved-jobs/remove/:savedJobId', authenticate, authorize(['candidate']), candidateController.deleteSavedJob);


// Create resume
candidateRouter.post('/resumes/create', authenticate, authorize(['candidate']), candidateUpload, candidateResumeController.createResume);

// Update resume
candidateRouter.put('/resumes/update/:id', authenticate, authorize(['candidate']), candidateUpload, candidateResumeController.updateResume);

// List resumes
candidateRouter.get('/resumes/get-all', authenticate, authorize(['candidate']), candidateResumeController.listResumes);

// Get single resume
candidateRouter.get('/resumes/get/:id', authenticate, authorize(['candidate']), candidateResumeController.getResume);

// Delete resume
candidateRouter.delete('/resumes/delete/:id', authenticate, authorize(['candidate']), candidateResumeController.deleteResume);

// Generate PDF CV
candidateRouter.get('/resumes/:id/generate-pdf', authenticate, authorize(['candidate']), candidateResumeController.generatePDF);

//cv management routes
// Upload CV file
candidateRouter.post('/cvs/upload', authenticate, authorize(['candidate']), cvUpload, candidateCvController.uploadCv);

// List CVs
candidateRouter.get('/cvs/list', authenticate, authorize(['candidate']), candidateCvController.listCvs);

// Delete CV
candidateRouter.delete('/cvs/delete/:id', authenticate, authorize(['candidate']), candidateCvController.deleteCv);

// Download resume
candidateRouter.get("/resume/download", authenticate, authorize(["candidate", "hr-admin", "superadmin"]), candidateController.getResumeDownloadUrl);

// HR admin download candidate resume (employers can only download from applicants)
candidateRouter.get( "/resume/download/:candidateId", authenticate, authorize(["hr-admin", "employer", "superadmin"]),candidateController.getResumeForHR);


// candidate dashboard

// Dashboard stats route
candidateRouter.get('/stats', authenticate, authorize(['candidate']), candidateDashboardController.getDashboardStats);

// Profile views data route
candidateRouter.get('/profile-views', authenticate, authorize(['candidate']), candidateDashboardController.getProfileViewsData);

// Recent activities route
candidateRouter.get('/recent-activities', authenticate, authorize(['candidate']), candidateDashboardController.getRecentActivity);

// Application trends route
candidateRouter.get('/application-trends', authenticate, authorize(['candidate']), candidateDashboardController.getApplicationTrends);

// Job type distribution route
candidateRouter.get('/job-type-distribution', authenticate, authorize(['candidate']), candidateDashboardController.getJobTypeDistribution);

// recommended jobs route
candidateRouter.get('/recommended-jobs', authenticate, authorize(['candidate']), candidateController.getRecommendedJobs);

// Public trending jobs
candidateRouter.get('/trending-jobs', candidateController.getTrendingJobs);

candidateRouter.get('/jobs/:id/similar', candidateController.getSimilarJobs);

// Notification routes
// Get all notifications
candidateRouter.get('/notifications', authenticate, authorize(['candidate', 'employer', 'hr-admin', 'superadmin']), notificationController.getNotifications);

// Get unread count
candidateRouter.get('/notifications/unread/count', authenticate, authorize(['candidate', 'employer', 'hr-admin', 'superadmin']), notificationController.getUnreadCount);

// Mark notification as read
candidateRouter.put('/notifications/:id/read', authenticate, authorize(['candidate', 'employer', 'hr-admin', 'superadmin']), notificationController.markAsRead);

// Mark all as read
candidateRouter.put('/notifications/mark-all-read', authenticate, authorize(['candidate', 'employer', 'hr-admin', 'superadmin']), notificationController.markAllAsRead);

// Delete notification
candidateRouter.delete('/notifications/:id', authenticate, authorize(['candidate', 'employer', 'hr-admin', 'superadmin']), notificationController.deleteNotification);

export default candidateRouter;
