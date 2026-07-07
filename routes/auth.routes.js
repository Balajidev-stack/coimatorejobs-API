// auth.routes.js
import { Router } from 'express';
import authentication from '../controller/auth.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { loginLimiter, forgotPasswordLimiter, resetPasswordLimiter } from '../middleware/rateLimiter.js';
 // New middleware for throttling

const authRouter = Router();

// Route for user signup
authRouter.post('/sign-up', authentication.signup);

// Route for user signin (with rate limiting)
authRouter.post('/sign-in', loginLimiter, authentication.signin);   // Apply throttling
authRouter.post('/sign-in/verify-otp', loginLimiter, authentication.verifySigninOtp);
authRouter.post('/sign-in/candidate/verify-otp', loginLimiter, authentication.verifyCandidateSigninOtp);

// Route for password reset request
authRouter.put('/reset-password', authenticate, authorize(['hr-admin', 'employer', 'candidate']), authentication.changePassword);

// Route for user signout
authRouter.post('/sign-out', authenticate, authentication.signout);

// Get fresh logged-in user status/profile summary
authRouter.get('/me', authenticate, authentication.getCurrentUser);

// Request password reset (send token)  - with rate limiting
authRouter.post('/forgot-password', forgotPasswordLimiter, authentication.forgotPassword);

// Reset password using token (no authentication) - with rate limiting
authRouter.post('/reset-password/:token', resetPasswordLimiter, authentication.resetPasswordWithToken);

// optional: Admin or superadmin can reset any user's password
authRouter.put('/admin/reset-user-password/:id', authentication.adminResetUserPassword);

// Get users by role (hr-admin and superadmin only)
authRouter.get('/users',authenticate, authorize(['hr-admin', 'superadmin']), authentication.getUsersByRole);

// Update user status (hr-admin or superadmin only)
// :id is the user ID whose status is to be updated
authRouter.put('/admin/users/status/:id', authenticate, authorize(['hr-admin', 'superadmin']), authentication.updateUserStatus);

// Create employer user (hr-admin and superadmin only)
authRouter.post('/admin/users', authenticate, authorize(['hr-admin', 'superadmin']), authentication.createAdminUser);
authRouter.put('/admin/users/:id', authenticate, authorize(['hr-admin', 'superadmin']), authentication.updateAdminUser);

// Get assigned users for hr-admin (hr-admin and superadmin only)
authRouter.get('/admin/users/assigned', authenticate, authorize(['hr-admin', 'superadmin']), authentication.getAssignedUsers);

/**
 * Soft delete user profile
 * - Self delete (candidate / employer)
 * - Admin delete (hr-admin / superadmin)
 */
authRouter.delete('/users/:id', authenticate,authorize(['candidate', 'employer', 'hr-admin', 'superadmin']),authentication.deleteUserProfile);


// Google OAuth2 login
authRouter.post('/google-login', authentication.googleLogin);


export default authRouter;
