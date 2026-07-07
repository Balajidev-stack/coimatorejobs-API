// auth.controller.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import PaymentPlan from "../models/paymentPlan.model.js";
import JobPost from "../models/jobs.model.js";
import JobApplication from "../models/jobApply.model.js";
import CompanyProfile from "../models/companyProfile.model.js";
import CandidateProfile from "../models/candidateProfile.model.js";
import CandidateResume from "../models/candidateResume.model.js";
import CandidateCv from "../models/candidateCv.model.js";
import JobAlert from "../models/jobAlert.model.js";
import ResumeAlert from "../models/resumeAlert.model.js";
import SavedJob from "../models/savedJob.model.js";
import SavedCandidate from "../models/savedCandidate.model.js";
import ResumeDownloadLog from "../models/resumeDownloadLog.model.js";
import Notification from "../models/notification.model.js";
import { JWT_SECRET, JWT_EXPIRES_IN, SUPERADMIN_EMAIL, THROTTLING_RETRY_DELAY_BASE } from "../config/env.js";
import crypto from 'crypto';
import { sendPasswordResetEmail, sendWelcomeEmail, sendSuperadminAlertEmail, sendUserStatusUpdateEmail, sendPasswordResetSuccessEmail, sendAdminPasswordResetEmail, sendProfileDeletionEmail, sendCandidateAccountDeletedAlertEmail, sendLoginOtpEmail } from '../utils/mailer.js';
import { BadRequestError, ForbiddenError,NotFoundError} from '../utils/errors.js';
import { isValidEmailAddress, normalizeEmail } from "../utils/emailValidation.js";
import { createNotification, notificationPresets } from "../utils/notificationHelper.js";

import { log } from "console";

import { OAuth2Client } from 'google-auth-library';
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const LOGIN_OTP_EXPIRY_MINUTES = 10;
const LOGIN_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_PUBLIC_EMPLOYER_EMAIL = 'hello@coimbatorejobs.in';
const INTERNAL_EMPLOYER_EMAIL_REGEX = /^employer_.*_@internal\.coimbatorejobs\.in$/i;

const getDefaultFreePlanAssignment = async (session = null) => {
  const query = PaymentPlan.findOne({
    status: 'Active',
    $or: [
      { planType: 'Free' },
      { name: /^free$/i, price: 0 },
    ],
  })
    .sort({ createdAt: -1 })
    .select('_id');

  if (session) {
    query.session(session);
  }

  const freePlan = await query;
  if (!freePlan) return {};

  return {
    activePaymentPlan: freePlan._id,
    paymentPlanAssignedAt: new Date(),
  };
};

const assignDefaultFreePlanIfMissing = async (user) => {
  if (!user || user.role !== 'employer' || user.activePaymentPlan) return user;

  const freePlanAssignment = await getDefaultFreePlanAssignment();
  if (!freePlanAssignment.activePaymentPlan) return user;

  user.activePaymentPlan = freePlanAssignment.activePaymentPlan;
  user.paymentPlanAssignedAt = freePlanAssignment.paymentPlanAssignedAt;
  await user.save({ validateBeforeSave: false });
  return user;
};

// Authentication controller object
const authentication = {};

const generateSixDigitOtp = () => `${crypto.randomInt(100000, 1000000)}`;

const hashLoginOtp = (otp, userId) => {
  return crypto
    .createHash('sha256')
    .update(`${otp}:${String(userId)}:${JWT_SECRET}`)
    .digest('hex');
};

const resolveLoginOtpRecipient = (user) => {
  if (user.role === 'candidate') {
    if (user.isSystemGeneratedEmail) return null;
    return user.email;
  }

  if (user.role === 'employer') {
    if (user.isSystemGeneratedEmail) {
      return user.contactEmail?.trim()?.toLowerCase() || null;
    }
    return user.email;
  }

  return null;
};

const getPublicEmployerEmail = (user) => {
  const email = (user?.email || '').trim().toLowerCase();
  if (
    user?.isSystemGeneratedEmail ||
    email.endsWith('@internal.coimbatorejobs.in') ||
    INTERNAL_EMPLOYER_EMAIL_REGEX.test(email)
  ) {
    return DEFAULT_PUBLIC_EMPLOYER_EMAIL;
  }
  return email || DEFAULT_PUBLIC_EMPLOYER_EMAIL;
};

const getRegistrationAlertAdmins = async () => {
  const configuredEmail = String(SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const admins = await User.find({
    role: { $in: ['hr-admin', 'superadmin'] },
    isActive: true,
    $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
  }).select('_id name email role status');

  const emailRecipients = new Set();
  if (configuredEmail) emailRecipients.add(configuredEmail);

  admins.forEach((admin) => {
    const email = String(admin.email || '').trim().toLowerCase();
    if (email) emailRecipients.add(email);
  });

  return {
    admins,
    emailRecipients: Array.from(emailRecipients),
  };
};

const notifyAdminsOfRegistration = async (newUser) => {
  try {
    const { admins, emailRecipients } = await getRegistrationAlertAdmins();
    const adminPath =
      newUser.role === 'employer'
        ? 'employers'
        : newUser.role === 'candidate'
          ? 'candidates'
          : 'users';

    const sentEmails = new Set();
    const buildDashboardLink = (role) =>
      `${process.env.FRONTEND_URL}/${role === 'superadmin' ? 'super-admin-dashboard' : 'hr-admin-dashboard'}/user-status?type=${adminPath}`;

    const emailTasks = admins
      .map((admin) => {
        const recipient = String(admin.email || '').trim().toLowerCase();
        if (!recipient || sentEmails.has(recipient)) return null;
        sentEmails.add(recipient);
        return sendSuperadminAlertEmail({
          superadminEmail: recipient,
          eventType: 'new_registration',
          userEmail: newUser.email,
          userRole: newUser.role,
          message: 'New user registration via signup form',
          dashboardLink: buildDashboardLink(admin.role),
        });
      })
      .filter(Boolean);

    emailRecipients
      .filter((recipient) => !sentEmails.has(recipient))
      .forEach((recipient) => {
        sentEmails.add(recipient);
        emailTasks.push(
          sendSuperadminAlertEmail({
            superadminEmail: recipient,
            eventType: 'new_registration',
            userEmail: newUser.email,
            userRole: newUser.role,
            message: 'New user registration via signup form',
            dashboardLink: buildDashboardLink('superadmin'),
          })
        );
      });

    await Promise.allSettled(emailTasks);

    await Promise.allSettled(
      admins.map((admin) =>
        createNotification(admin._id, 'email_update', {
          ...notificationPresets.emailUpdate(
            'New Registration Pending',
            `${newUser.name} registered as ${newUser.role}. Please review the account status.`
          ),
          actionUrl:
            admin.role === 'superadmin'
              ? `/super-admin-dashboard/user-status?type=${adminPath}`
              : `/hr-admin-dashboard/user-status?type=${adminPath}`,
          icon: 'la-user-plus',
          color: '#f59e0b',
        })
      )
    );
  } catch (error) {
    console.error('Failed to notify admins about registration:', error);
  }
};

/**
 * Registers a new user (candidate or employer) with transaction support
 * @param {Object} req - Request object containing name, email, password, and role
 * @param {Object} res - Response object to send back the result
 * @param {Function} next - Next middleware function for error handling
 */
authentication.signup = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { name, email, password, role } = req.body;
        const normalizedEmail = normalizeEmail(email);
        // Only allow candidate, employer, hr-admin roles on signup
        const safeRole = ['candidate', 'employer', 'hr-admin'].includes(role) ? role : 'candidate';

        // Validate required fields
        if (!name || !normalizedEmail || !password) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'All fields (name, email, password) are required' });
        }

        if (!isValidEmailAddress(normalizedEmail)) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ message: "Please enter a valid email address" });
        }

        // Check for existing users with the same email.
        // If all existing records are deleted/deactivated, purge them and allow fresh signup.
        const existingUsers = await User.find({ email: normalizedEmail })
          .sort({ createdAt: -1 })
          .session(session);

        if (existingUsers.length > 0) {
            const hasActiveAccount = existingUsers.some(
              (user) => user.isActive && !user.isDeleted
            );

            if (hasActiveAccount) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ message: "User already exists, Please Login" });
            }

            await User.deleteMany({ email: normalizedEmail }).session(session);
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Candidate and employer self-signup must stay pending until HR/Superadmin approval.
        const status = ['candidate', 'employer'].includes(safeRole) ? 'pending' : 'approved';
        
        // old approval logic (we can handle in frontend for now)
         // Approval logic
        // const status = ['candidate', 'employer'].includes(safeRole)
        //   ? 'pending'
        //   : 'approved';

        // Create new user with optional role (defaults to 'candidate' in schema)
        const freePlanAssignment =
          safeRole === 'employer'
            ? await getDefaultFreePlanAssignment(session)
            : {};
        const newUser = new User({
          name,
          email: normalizedEmail,
          password: hashedPassword,
          role: safeRole,
          status,
          ...freePlanAssignment
        });
        await newUser.save({ session });

        // Generate JWT token
        const token = jwt.sign({ userId: newUser._id, role: newUser.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        // Commit transaction and end session
        await session.commitTransaction();
        session.endSession();

        // Send welcome email to new user
        await sendWelcomeEmail({ recipient: normalizedEmail, name });

        // Small delay for Mailtrap
        await new Promise(resolve => setTimeout(resolve, 6000)); //remove when in production

        await notifyAdminsOfRegistration(newUser);

        // Send success response
        return res.status(201).json({
            success: true,
            message: ['candidate', 'employer'].includes(safeRole)
              ? `${safeRole === 'employer' ? 'Employer' : 'Candidate'} registered successfully. Your account is pending approval.`
              : "User created successfully",
            user: {
                token,
                id: newUser._id,
                name: newUser.name,
                email: newUser.email,
                role: newUser.role,
                status: newUser.status,
                activePaymentPlan: newUser.activePaymentPlan || null
            }
        });
    } catch (error) {
        console.error("Error in authentication.signup:", error);
        await session.abortTransaction();
        session.endSession();
        next(error); // Pass to error middleware
    }
};

/**
 * hr-admin or superadmin creates an employer or candidate account
 * @param {Object} req - Request object containing name, email, password, and role
 * @param {Object} res - Response object to send back the result
 * @param {Function} next - Next middleware function for error handling
 */
authentication.createAdminUser = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { name, email, password, role, assignedHrAdminId } = req.body;
    const creator = req.user; // hr-admin or superadmin

     // Only hr-admin or superadmin can access this API
    if (!['hr-admin', 'superadmin'].includes(creator.role)) {
      return res.status(403).json({ message: 'Not allowed, Only hr-admin or superadmin can create employer accounts' });
    }

    // Basic validation
    if (!name || !password) {
      return res.status(400).json({
        message: 'Name and password are required'
      });
    }

    // ❌ Prevent creating superadmin via API
    if (role === 'superadmin') {
      return res.status(403).json({
        message: 'Superadmin accounts cannot be created via API'
      });
    }

    // Role permission matrix
    const rolePermissions = {
      'hr-admin': ['employer', 'candidate'],
      'superadmin': ['employer', 'candidate', 'hr-admin']
    };

    if (!rolePermissions[creator.role]?.includes(role)) {
      return res.status(403).json({
        message: `You are not allowed to create ${role} accounts`
      });
    }

    // Email is optional for admin-created users. If not provided, keep it empty
    // and rely on unique loginId for account identification.
    let finalEmail = normalizeEmail(email);

    let isSystemGeneratedEmail = false;

    if (!finalEmail) {
      isSystemGeneratedEmail = true;
    }

    if (!isSystemGeneratedEmail && !isValidEmailAddress(finalEmail)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        message: 'Please enter a valid email address'
      });
    }

    // Check uniqueness
    if (!isSystemGeneratedEmail) {
      const existing = await User.findOne({ email: finalEmail }).session(session);
      if (existing) {
        return res.status(400).json({
          message: 'User already exists with this email'
        });
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate Login ID
    const loginId = `${role.substring(0,3).toUpperCase()}-${Date.now().toString().slice(-6)}`;

    // Determine creatorId (for assignment)
    let creatorId = creator.id;

    const isSuperadminAssignedUser =
      creator.role === 'superadmin' && ['employer', 'candidate'].includes(role);
    const resolvedStatus = isSuperadminAssignedUser ? 'pending' : 'approved';
    const resolvedAssignmentSource = isSuperadminAssignedUser ? 'superadmin-assigned' : creator.role;

    const freePlanAssignment =
      role === 'employer'
        ? await getDefaultFreePlanAssignment(session)
        : {};

   // Admin-created users: HR admin creates as approved, Superadmin-assigned users remain pending.
    const createPayload = {
      name,
      password: hashedPassword,
      role,
      status: resolvedStatus,
      createdBy: creatorId,
      assignedHrAdmin: isSuperadminAssignedUser ? assignedHrAdminId : null,
      assignmentSource: resolvedAssignmentSource,
      isSystemGeneratedEmail,
      loginId,
      ...freePlanAssignment
    };
    if (!isSystemGeneratedEmail) {
      createPayload.email = finalEmail;
    }

    const [user] = await User.create([createPayload], { session });

    // AUTO ASSIGN EMPLOYER TO HR-ADMIN
   if (creator.role === 'hr-admin') {
      const updateField =
        role === 'employer'
          ? { employerIds: user._id }
          : { candidateIds: user._id };

      await User.updateOne(
        { _id: creator.id },
        { $addToSet: updateField },
        { session }
      );
    }

    // If Superadmin creates HR Admin → assign to hrAdminIds
    if (creator.role === 'superadmin' && role === 'hr-admin') {
      await User.updateOne(
        { _id: creator.id },
        { $addToSet: { hrAdminIds: user._id } },
        { session }
      );
    }

    // SUPERADMIN creates employer/candidate → assign to selected HR Admin
    if (creator.role === 'superadmin' && ['employer', 'candidate'].includes(role)) {
      if (!assignedHrAdminId) {
        return res.status(400).json({ message: 'HR Admin must be selected for assignment' });
      }

      const hrAdmin = await User.findById(assignedHrAdminId).session(session);
      if (!hrAdmin || hrAdmin.role !== 'hr-admin') {
        return res.status(400).json({ message: 'Invalid HR Admin selected' });
      }

      const updateField = role === 'employer'
        ? { employerIds: user._id }
        : { candidateIds: user._id };

      await User.updateOne({ _id: assignedHrAdminId }, { $addToSet: updateField }, { session });
    }

    await session.commitTransaction();
    session.endSession();

    const createdByLabel = creator.email || (creator.role === 'superadmin' ? 'Super Admin' : 'HR Admin');

     // Send welcome email only if real email provided
    if (!isSystemGeneratedEmail) {
      await sendWelcomeEmail({
        recipient: finalEmail,
        name,
        createdBy: createdByLabel,
        role
      });

      await sendSuperadminAlertEmail({
        superadminEmail: SUPERADMIN_EMAIL,
        eventType: 'new_registration',
        userEmail: finalEmail,
        userRole: role,
        message: `${role} account created by ${createdByLabel}`,
        actorEmail: creator.email || (creator.role === 'superadmin' ? 'Super Admin' : 'HR Admin')
      });
    }

    // Small delay for Mailtrap
    // await new Promise(resolve => setTimeout(resolve, 6000)); //remove when in production

    res.status(201).json({
      success: true,
      message: isSuperadminAssignedUser
        ? `${role} account assigned to HR Admin and marked pending for HR approval`
        : `${role} created & assigned successfully`,
      data: {
        _id: user._id,
        name: user.name,
        role: user.role,
        email: getPublicEmployerEmail(user),
        loginId: user.loginId,
        isSystemGeneratedEmail: user.isSystemGeneratedEmail
      }
    });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
};

/**
 * Update admin-manageable account by hr-admin/superadmin.
 * - hr-admin: can edit only assigned employers/candidates
 * - superadmin: can edit assigned employers/candidates and any hr-admin
 */
authentication.updateAdminUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email } = req.body;

    const editor = await User.findById(req.user.id).select('role employerIds candidateIds');
    if (!editor || !['hr-admin', 'superadmin'].includes(editor.role)) {
      return res.status(403).json({ message: 'Not allowed to edit accounts' });
    }

    const targetUser = await User.findById(id);
    if (!targetUser || !['employer', 'candidate', 'hr-admin'].includes(targetUser.role)) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (editor.role === 'hr-admin' && !['employer', 'candidate'].includes(targetUser.role)) {
      return res.status(403).json({
        message: 'HR Admin can edit only employer and candidate accounts'
      });
    }

    // Superadmin can edit HR-admin accounts directly.
    if (editor.role === 'superadmin' && targetUser.role === 'hr-admin') {
      const updatePayload = {};

      if (typeof name === 'string' && name.trim()) {
        updatePayload.name = name.trim();
      }

      if (typeof email === 'string' && email.trim()) {
        const normalizedEmail = normalizeEmail(email);

        if (!isValidEmailAddress(normalizedEmail)) {
          return res.status(400).json({ message: 'Please enter a valid email address' });
        }

        const existingEmailUser = await User.findOne({
          email: normalizedEmail,
          _id: { $ne: targetUser._id }
        }).select('_id');

        if (existingEmailUser) {
          return res.status(400).json({ message: 'Email already in use by another account' });
        }

        updatePayload.email = normalizedEmail;
      }

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ message: 'No valid fields provided for update' });
      }

      const updatedUser = await User.findByIdAndUpdate(
        id,
        updatePayload,
        { new: true, runValidators: true, select: '-password' }
      );

      return res.status(200).json({
        success: true,
        message: 'HR Admin updated successfully',
        data: updatedUser
      });
    }

    let isAssignedUser = false;

    if (editor.role === 'hr-admin') {
      const assignedEmployer = (editor.employerIds || []).some(
        (empId) => empId.toString() === id.toString()
      );
      const assignedCandidate = (editor.candidateIds || []).some(
        (candidateId) => candidateId.toString() === id.toString()
      );
      isAssignedUser = assignedEmployer || assignedCandidate;
    } else if (editor.role === 'superadmin') {
      const assignedField = targetUser.role === 'candidate' ? 'candidateIds' : 'employerIds';
      const assignedHrAdmin = await User.findOne({
        role: 'hr-admin',
        isActive: true,
        [assignedField]: targetUser._id
      }).select('_id');
      isAssignedUser = !!assignedHrAdmin;
    }

    if (!isAssignedUser) {
      return res.status(403).json({
        message: `You can edit only assigned ${targetUser.role === 'candidate' ? 'candidates' : 'employers'}`
      });
    }

    const updatePayload = {};

    if (typeof name === 'string' && name.trim()) {
      updatePayload.name = name.trim();
    }

    if (typeof email === 'string' && email.trim()) {
      const normalizedEmail = normalizeEmail(email);

      if (!isValidEmailAddress(normalizedEmail)) {
        return res.status(400).json({ message: 'Please enter a valid email address' });
      }

      const existingEmailUser = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: targetUser._id }
      }).select('_id');

      if (existingEmailUser) {
        return res.status(400).json({ message: 'Email already in use by another account' });
      }

      updatePayload.email = normalizedEmail;
      updatePayload.isSystemGeneratedEmail = false;
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      id,
      updatePayload,
      { new: true, runValidators: true, select: '-password' }
    );

    return res.status(200).json({
      success: true,
      message: `${targetUser.role === 'candidate' ? 'Candidate' : 'Employer'} updated successfully`,
      data: updatedUser
    });
  } catch (error) {
    next(error);
  }
};

 
/**
 * Fetch employers/candidates belonging to hr-admin or all for superadmin
 */
authentication.getAssignedUsers = async (req, res, next) => {
  try {
    const { roles } = req.query;
 
    // IMPORTANT: fetch fresh user from DB
    const loggedInUser = await User.findById(req.user.id)
      .select('role employerIds candidateIds');
 
    if (!loggedInUser) {
      return res.status(401).json({ message: 'User not found' });
    }
 
    let roleFilter;

    if (roles) {
      roleFilter = roles.split(',').map(r => r.trim());
    } else {
      // Default behavior
      roleFilter =
        loggedInUser.role === 'superadmin'
          ? ['employer', 'candidate', 'hr-admin']
          : ['employer', 'candidate'];
    }

    const includesHrAdminRole = roleFilter.includes('hr-admin');
    const includesAssignableRole = roleFilter.some((role) => ['employer', 'candidate'].includes(role));
    const shouldApplyAssignedFilter = includesAssignableRole && !includesHrAdminRole;
 
    let query = {
      role: { $in: roleFilter },
      isActive: true,
      $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }]
    };
 
    // console.log("test", query);
   
 
    // HR-ADMIN → ONLY ASSIGNED USERS
    // if (loggedInUser.role === 'hr-admin') {
    //   query.createdBy = loggedInUser.id; 
    // }
    /**
     * HR-ADMIN → ONLY USERS ASSIGNED TO THEM
     */
    if (shouldApplyAssignedFilter) {
      let assignedIds = [];

      // HR-ADMIN -> users assigned to this HR-admin
      if (loggedInUser.role === 'hr-admin') {
        assignedIds = [
          ...(loggedInUser.employerIds || []),
          ...(loggedInUser.candidateIds || [])
        ];
      }

      // SUPERADMIN -> users assigned to any HR-admin
      if (loggedInUser.role === 'superadmin') {
        const hrAdmins = await User.find({ role: 'hr-admin', isActive: true })
          .select('employerIds candidateIds');

        assignedIds = hrAdmins.flatMap((hrAdmin) => ([
          ...(hrAdmin.employerIds || []),
          ...(hrAdmin.candidateIds || [])
        ]));
      }

      query._id = { $in: [...new Set(assignedIds.map((id) => id.toString()))] };
    }
 
    // SUPERADMIN → sees all
    const users = await User.find(query, { password: 0 })
      .sort({ createdAt: -1 });

    const sanitizedUsers = users.map((userDoc) => {
      const userObj = userDoc.toObject();
      if (userObj.role === 'employer') {
        userObj.email = getPublicEmployerEmail(userObj);
      }
      return userObj;
    });
 
    res.status(200).json({
      success: true,
      count: sanitizedUsers.length,
      data: sanitizedUsers
    });
 
  } catch (error) {
    next(error);
  }
};


/**
 * Authenticates a user and returns a JWT token
 * @param {Object} req - Request object containing email and password
 * @param {Object} res - Response object to send back authentication result
 * @param {Function} next - Next middleware function for error handling
 */
authentication.signin = async (req, res, next) => {
    try {
        const { identifier, password, requestedRole } = req.body;
        const normalizedIdentifier = identifier?.trim();
        const normalizedEmailIdentifier = normalizedIdentifier?.toLowerCase();
        const normalizedRequestedRole = requestedRole?.trim()?.toLowerCase();
        // identifier = email OR loginId

        // Validate required fields
        if (!normalizedIdentifier || !password) {
            return res.status(400).json({ message: "Login ID/Email and password are required" });
         }

        if (normalizedIdentifier.includes('@') && !isValidEmailAddress(normalizedEmailIdentifier)) {
          return res.status(400).json({ message: "Please enter a valid email address" });
        }

        // Prefer the latest active account and ignore soft-deleted users.
        let user = await User.findOne({
            isActive: true,
            $or: [
              { isDeleted: false },
              { isDeleted: { $exists: false } }
            ],
            $and: [{
              $or: [
                { email: normalizedEmailIdentifier },
                { loginId: normalizedIdentifier }
              ]
            }]
        }).sort({ createdAt: -1 });

        // If no active user was found, look for any matching record to return a precise message.
        if (!user) {
          user = await User.findOne({
            $or: [
              { email: normalizedEmailIdentifier },
              { loginId: normalizedIdentifier }
            ]
          }).sort({ createdAt: -1 });
        }

        if (!user) {
            const registerLabel = normalizedRequestedRole === 'employer' ? 'Employer' : 'Candidate';
            return res.status(404).json({
              message: `User not found. Please register as ${registerLabel} first.`
            });
        }

        // Check if account active
        if (!user.isActive || user.isDeleted) {
            return res.status(403).json({ message: "User account is deactivated" });
        }

        // Verify password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid email or password" });
        }

        // Prevent OTP send/login when user attempts with wrong role tab.
        if (normalizedRequestedRole === 'candidate' && user.role !== 'candidate') {
          return res.status(403).json({
            message: `Account is registered as ${user.role}. Please login via Employer tab.`
          });
        }

        if (
          normalizedRequestedRole === 'employer' &&
          !['employer', 'hr-admin', 'superadmin'].includes(user.role)
        ) {
          return res.status(403).json({
            message: `Account is registered as ${user.role}. Please login via Candidate tab.`
          });
        }

        // Check approval status for candidate and employer roles(for now this we can handle in frontend)
        // if (user.status !== 'approved') {
        //   return res.status(403).json({
        //     message: `Account is ${user.status}. Please wait for approval.`
        //   });
        // }

        await assignDefaultFreePlanIfMissing(user);

        if (['candidate', 'employer'].includes(user.role)) {
          const otpRecipient = resolveLoginOtpRecipient(user);
          if (!otpRecipient) {
            return res.status(403).json({
              message: `${user.role === 'employer' ? 'Employer' : 'Candidate'} account does not have a valid email for OTP login`
            });
          }

          const otp = generateSixDigitOtp();
          const otpHash = hashLoginOtp(otp, user._id);
          const otpExpiresAt = new Date(Date.now() + LOGIN_OTP_EXPIRY_MINUTES * 60 * 1000);

          user.loginOtpHash = otpHash;
          user.loginOtpExpiresAt = otpExpiresAt;
          user.loginOtpAttempts = 0;
          await user.save({ validateBeforeSave: false });

          await sendLoginOtpEmail({
            recipient: otpRecipient,
            name: user.name,
            otp,
            expiresInMinutes: LOGIN_OTP_EXPIRY_MINUTES,
            role: user.role
          });

          const challengeToken = jwt.sign(
            { userId: user._id, role: user.role, purpose: 'login_otp' },
            JWT_SECRET,
            { expiresIn: `${LOGIN_OTP_EXPIRY_MINUTES}m` }
          );

          return res.status(200).json({
            success: true,
            requiresOtp: true,
            message: 'OTP sent to your email. Please verify to continue.',
            otpExpiresInSeconds: LOGIN_OTP_EXPIRY_MINUTES * 60,
            challengeToken,
            user: {
              id: user._id,
              name: user.name,
              role: user.role,
              status: user.status,
              loginId: user.loginId || null,
              email: user.email,
              isSystemGeneratedEmail: user.isSystemGeneratedEmail,
              activePaymentPlan: user.activePaymentPlan || null
            }
          });
        }

        // Generate JWT token
        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        // Send success response
        return res.status(200).json({
            success: true,
            message: "User signed in successfully",
            user: {
                token,
                id: user._id,
                name: user.name,
                role: user.role,
                status: user.status,
                loginId: user.loginId || null,
                // Hide internal email from frontend
                email: user.isSystemGeneratedEmail ? null : user.email,
                isSystemGeneratedEmail: user.isSystemGeneratedEmail,
                activePaymentPlan: user.activePaymentPlan || null

            }
        });
    } catch (error) {
        console.error("Error in authentication.signin:", error);
        next(error);
    }
};

authentication.verifySigninOtp = async (req, res, next) => {
  try {
    const { challengeToken, otp } = req.body;

    if (!challengeToken || !otp) {
      return res.status(400).json({ message: 'challengeToken and otp are required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(challengeToken, JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ message: 'OTP session expired. Please login again.' });
    }

    if (decoded.purpose !== 'login_otp' || !decoded.userId) {
      return res.status(401).json({ message: 'Invalid OTP session. Please login again.' });
    }

    const user = await User.findById(decoded.userId).select('+loginOtpHash +loginOtpExpiresAt');
    if (!user || !['candidate', 'employer'].includes(user.role)) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.isActive || user.isDeleted) {
      return res.status(403).json({ message: 'User account is deactivated' });
    }

    if (!user.loginOtpHash || !user.loginOtpExpiresAt) {
      return res.status(400).json({ message: 'No OTP request found. Please login again.' });
    }

    if (new Date() > new Date(user.loginOtpExpiresAt)) {
      user.loginOtpHash = undefined;
      user.loginOtpExpiresAt = undefined;
      user.loginOtpAttempts = 0;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({ message: 'OTP expired. Please login again.' });
    }

    if ((user.loginOtpAttempts || 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many incorrect OTP attempts. Please login again.' });
    }

    const normalizedOtp = String(otp).trim();
    const incomingHash = hashLoginOtp(normalizedOtp, user._id);

    if (incomingHash !== user.loginOtpHash) {
      user.loginOtpAttempts = (user.loginOtpAttempts || 0) + 1;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    user.loginOtpHash = undefined;
    user.loginOtpExpiresAt = undefined;
    user.loginOtpAttempts = 0;
    await assignDefaultFreePlanIfMissing(user);
    await user.save({ validateBeforeSave: false });

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(200).json({
      success: true,
      message: 'User signed in successfully',
      user: {
        token,
        id: user._id,
        name: user.name,
        role: user.role,
        status: user.status,
        loginId: user.loginId || null,
        email: user.isSystemGeneratedEmail ? null : user.email,
        isSystemGeneratedEmail: user.isSystemGeneratedEmail,
        activePaymentPlan: user.activePaymentPlan || null
      }
    });
  } catch (error) {
    console.error('Error in authentication.verifySigninOtp:', error);
    next(error);
  }
};

// Backward compatibility
authentication.verifyCandidateSigninOtp = authentication.verifySigninOtp;


/**
 * Allows an authenticated user to change their password
 * @param {Object} req - Request object containing currentPassword, newPassword, and confirmPassword
 * @param {Object} res - Response object to send back the result
 * @param {Function} next - Next middleware function for error handling
 */
authentication.changePassword = async(req, res, next) => {
    try {

        const userId = req.user.id; // Get user ID from authenticated request
        const { currentPassword, newPassword, confirmPassword } = req.body;

        //validate required fields
        if(!currentPassword || !newPassword || !confirmPassword) {
            return res.status(400).json({ message: "Current password, new password and confirm password are required" });
        }

        if(newPassword !== confirmPassword) {
            return res.status(400).json({ message: "New password and confirm password do not match" });
        }

        // Find user by ID
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Current password is incorrect" });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const hashedNewPassword = await bcrypt.hash(newPassword, salt);
        // Update user's password
        user.password = hashedNewPassword;
        await user.save({ validateBeforeSave: false });
        // Send success response
        return res.status(200).json({
            success: true,
            message: "Password changed successfully"
        });

        
    } catch (error) {
        console.error("Error in authentication.changePassword:", error);
        next(error);
    }
} 


/**
 * Allows admin or superadmin to change their password
 * @param {Object} req - Request object containing currentPassword, newPassword, and confirmPassword
 * @param {Object} res - Response object to send back the result
 * @param {Function} next - Next middleware function for error handling
 */
authentication.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return res.status(400).json({ message: 'Email is required' });
    if (!isValidEmailAddress(normalizedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+resetPasswordToken +resetPasswordExpire');
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Generate one-time nonce + signed reset token
    const resetNonce = crypto.randomBytes(32).toString('hex');
    const resetToken = jwt.sign(
      { purpose: 'password_reset', userId: String(user._id), nonce: resetNonce },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    const resetTokenHash = crypto.createHash('sha256').update(resetNonce).digest('hex');

    // Save token and expiry in user doc
    user.resetPasswordToken = resetTokenHash;
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 mins
    await user.save();

    // Send reset email
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${encodeURIComponent(resetToken)}`;
    await sendPasswordResetEmail({
      recipient: user.email,
      name: user.name || user.email,
      resetUrl
    });

    res.status(200).json({ success: true, message: 'Password reset link sent to your email' });
  } catch (error) {
    console.error('Error in forgotPassword:', error);
    next(error);
  }
};



authentication.resetPasswordWithToken = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { newPassword, confirmPassword } = req.body;

    if (!newPassword || !confirmPassword)
      return res.status(400).json({ message: 'New password and confirm password are required' });

    if (newPassword !== confirmPassword)
      return res.status(400).json({ message: 'Passwords do not match' });

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return res.status(400).json({ message: 'Reset token is invalid or expired' });
    }

    if (decoded?.purpose !== 'password_reset' || !decoded?.userId || !decoded?.nonce) {
      return res.status(400).json({ message: 'Reset token is invalid or expired' });
    }

    // Find user with valid one-time nonce
    const user = await User.findOne({
      _id: decoded.userId,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user)
      return res.status(400).json({ message: 'Reset token is invalid or expired' });

    const expectedHash = crypto.createHash('sha256').update(decoded.nonce).digest('hex');
    if (!user.resetPasswordToken || user.resetPasswordToken !== expectedHash) {
      return res.status(400).json({ message: 'Reset token is invalid or already used' });
    }

    // Set new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;

    await user.save();

    // Send password reset success email
    await sendPasswordResetSuccessEmail({ recipient: user.email, name: user.name });

    res.status(200).json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    console.error('Error in resetPasswordWithToken:', error);
    next(error);
  }
};


authentication.adminResetUserPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) return res.status(400).json({ message: 'New password is required' });

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    // Send admin reset notification email to user
    await sendAdminPasswordResetEmail({
      recipient: user.email,
      name: user.name,
      adminEmail: req.user.email
    });
    // Send alert to superadmin
    await sendSuperadminAlertEmail({
      superadminEmail: SUPERADMIN_EMAIL,
      eventType: 'password_reset',
      newUserEmail: user.email,
      newUserRole: user.role,
      message: `Admin reset password for user ${user.email} by ${req.user.email}`,
      actorEmail: req.user.email
    });

    res.status(200).json({
      success: true,
      message: `Password reset successfully for user ${user.email}`
    });
  } catch (error) {
    console.error('Error in adminResetUserPassword:', error);
    next(error);
  }
};

/**
 * Fetch users based on role filters
 * Accessible only to HR-Admin and Superadmin
 *
 * Query Params:
 * roles=employer
 * roles=candidate
 * roles=employer,candidate
 */
authentication.getUsersByRole = async (req, res, next) => {
  try {
    const { roles, page = 1, limit = 20, status, search } = req.query;
    const loggedInUser = await User.findById(req.user.id).select('role employerIds candidateIds');
    if (!loggedInUser) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Default roles
    let roleFilter = ['candidate', 'employer'];
    if (roles) {
      roleFilter = roles.split(',').map(r => r.trim());
    }

    // Base query
    let query = {
      role: { $in: roleFilter },
      isActive: true,
      $or: [
        { isDeleted: false },
        { isDeleted: { $exists: false } }
      ]
    };

    // Optional status filter
    const normalizedStatus = String(status || '').trim().toLowerCase();
    if (normalizedStatus && normalizedStatus !== 'all') {
      const allowedStatuses = ['pending', 'approved', 'rejected'];
      if (allowedStatuses.includes(normalizedStatus)) {
        if (normalizedStatus === 'pending') {
          // Backward compatibility: old users may have missing/null status; treat them as pending.
          query.$and = query.$and || [];
          query.$and.push({
            $or: [
              { status: 'pending' },
              { status: { $exists: false } },
              { status: null },
            ],
          });
        } else {
          query.status = normalizedStatus;
        }
      }
    }

    // Optional keyword search across key fields
    const normalizedSearch = String(search || '').trim();
    if (normalizedSearch) {
      const regex = new RegExp(normalizedSearch, 'i');
      query.$and = query.$and || [];
      query.$and.push(
        {
          $or: [
            { name: regex },
            { email: regex },
            { loginId: regex },
            { contactEmail: regex },
            { role: regex },
            { status: regex },
          ],
        },
      );
    }

    /**
     * HR-ADMIN RULE:
     * Show only users assigned to this HR-admin
     */
    if (loggedInUser.role === 'hr-admin') {
      const assignedIds = [
        ...(loggedInUser.employerIds || []),
        ...(loggedInUser.candidateIds || []),
      ].map((id) => id.toString());

      if (normalizedStatus === 'pending') {
        query.$and = query.$and || [];
        query.$and.push({
          $or: [
            { _id: { $in: [...new Set(assignedIds)] } },
            { assignmentSource: 'self-signup' },
            { assignmentSource: { $exists: false } },
            { assignedHrAdmin: null },
          ],
        });
      } else {
        query._id = { $in: [...new Set(assignedIds)] };
      }
    }

    // For pending users that are explicitly assigned by superadmin,
    // only the assigned HR admin should action them (hide from superadmin user-status list).
    if (loggedInUser.role === 'superadmin' && normalizedStatus === 'pending') {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { assignmentSource: { $ne: 'superadmin-assigned' } },
          { assignmentSource: { $exists: false } },
        ],
      });
    }

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.max(1, parseInt(limit, 10) || 20);
    const skip = (pageNumber - 1) * limitNumber;
    const usersPromise = User.find(query, { password: 0 })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber);

    const countPromise = User.countDocuments(query);

    const [users, totalCount] = await Promise.all([usersPromise, countPromise]);

    res.status(200).json({
      success: true,
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(totalCount / limitNumber),
      totalCount,
      data: users
    });
  } catch (error) {
    console.error('Error in getUsersByRole:', error);
    next(error);
  }
};
 

/**
 * Approve or reject a user account
 * Accessible only to HR-Admin and Superadmin
 *
 * Body Params:
 * status: 'approved' | 'rejected'
 */
authentication.updateUserStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    // console.log("statussssssssssssss", status);
    if (!['approved', 'rejected'].includes(status)) {
      throw new Error('Invalid status');
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    // If a candidate/employer was assigned by superadmin to a specific HR admin,
    // only that assigned HR admin can approve/reject.
    if (
      targetUser.assignmentSource === 'superadmin-assigned' &&
      ['candidate', 'employer'].includes(targetUser.role)
    ) {
      if (req.user.role !== 'hr-admin') {
        return res.status(403).json({
          success: false,
          message: 'Only the assigned HR Admin can approve this user'
        });
      }
      if (!targetUser.assignedHrAdmin || targetUser.assignedHrAdmin.toString() !== req.user.id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'This user is assigned to another HR Admin'
        });
      }
    }

    targetUser.status = status;
    const user = await targetUser.save();


    // Candidate and employer should see account approve/reject updates in in-app notifications.
    if (['candidate', 'employer'].includes(user.role) && ['approved', 'rejected'].includes(status)) {
      const statusLabel = status === 'approved' ? 'approved' : 'rejected';
      const notificationData = notificationPresets.profileUpdate(
        `Your account status has been ${statusLabel} by admin.`
      );
      const actionUrl =
        user.role === 'employer'
          ? '/employers-dashboard/dashboard'
          : '/candidates-dashboard/notifications';

      await createNotification(user._id, 'profile_update', {
        ...notificationData,
        actionUrl,
        icon: status === 'approved' ? 'la-check-circle' : 'la-times-circle',
        color: status === 'approved' ? '#22c55e' : '#ef4444',
      });
    }

    // HR-Admin / Superadmin should also receive related in-app notifications.
    const actorName = req.user.name || req.user.email || 'Admin';
    const actorRoleLabel = req.user.role === 'superadmin' ? 'Super Admin' : 'HR Admin';
    const actionLabel = status === 'approved' ? 'approved' : 'rejected';

    // Notify the acting admin about the completed action.
    await createNotification(req.user.id, 'email_update', {
      ...notificationPresets.emailUpdate(
        'User Status Updated',
        `${actorRoleLabel} ${actorName} ${actionLabel} ${user.name} (${user.role}).`
      ),
      actionUrl:
        req.user.role === 'superadmin'
          ? '/super-admin-dashboard/user-status'
          : '/hr-admin-dashboard/user-status',
      icon: status === 'approved' ? 'la-check-circle' : 'la-times-circle',
      color: status === 'approved' ? '#22c55e' : '#ef4444',
    });

    // Notify all superadmins when a HR-Admin performs the update.
    if (req.user.role !== 'superadmin') {
      const superadmins = await User.find({
        role: 'superadmin',
        isActive: true,
      }).select('_id');

      await Promise.all(
        superadmins
          .filter((admin) => admin?._id?.toString() !== req.user.id?.toString())
          .map((admin) =>
            createNotification(admin._id, 'email_update', {
              ...notificationPresets.emailUpdate(
                'User Status Changed',
                `${actorRoleLabel} ${actorName} ${actionLabel} ${user.name} (${user.role}).`
              ),
              actionUrl: '/super-admin-dashboard/user-status',
              icon: status === 'approved' ? 'la-check-circle' : 'la-times-circle',
              color: status === 'approved' ? '#22c55e' : '#ef4444',
            })
          )
      );
    }

    // Send status update email to user
    const statusEmailRecipient = normalizeEmail(user.email);
    if (isValidEmailAddress(statusEmailRecipient)) {
      await sendUserStatusUpdateEmail({
        recipient: statusEmailRecipient,
        name: user.name,
        status: status,
        role: user.role
      });
    } else {
      console.warn(
        `[USER_STATUS_EMAIL] Skipped ${status} email for user=${user._id} (${user.role}) because recipient is invalid/missing: ${user.email || 'empty'}`
      );
    }
    // Send alert to superadmin (if not superadmin updating)
    if (req.user.role !== 'superadmin') {
      await sendSuperadminAlertEmail({
        superadminEmail: SUPERADMIN_EMAIL,
        eventType: status === 'approved' ? 'approved' : 'rejected',
        userEmail: user.email,
        userRole: user.role,
        message: `User status updated to ${status} by ${req.user.email}`,
        actorEmail: req.user.email
      });
    }

    res.status(200).json({
      success: true,
      message: `User ${status} successfully`
    });
  } catch (error) {
    console.error('Error in updateUserStatus:', error);
    next(error);
  }
};




/**
 * Signs out the user (client-side token invalidation only)
 * @param {Object} req - Request object (not used)
 * @param {Object} res - Response object to confirm sign-out
 */
authentication.signout = (req, res) => {
    // Note: JWT is stateless; client should remove token locally
    // Future enhancement: Implement server-side token blacklisting if needed
    return res.status(200).json({ success: true, message: "User signed out successfully" });
};

authentication.getCurrentUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select(
      '_id name email role status loginId isSystemGeneratedEmail activePaymentPlan paymentPlanAssignedAt'
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.isSystemGeneratedEmail ? null : user.email,
        role: user.role,
        status: user.status,
        loginId: user.loginId || null,
        isSystemGeneratedEmail: user.isSystemGeneratedEmail,
        activePaymentPlan: user.activePaymentPlan || null,
        paymentPlanAssignedAt: user.paymentPlanAssignedAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Soft delete a user profile
 *
 * Who can delete:
 * - Candidate / Employer → their own profile
 * - HR-Admin / Superadmin → any candidate or employer
 *
 * @route DELETE /api/v1/auth/users/:id
 * @access Private
 */
authentication.deleteUserProfile = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const loggedInUser = req.user;
    const targetUserId = req.params.id;

    const targetUser = await User.findById(targetUserId).session(session);
    if (!targetUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'User not found' });
    }

    // Permission checks
    const isSelfDelete =
      loggedInUser.id.toString() === targetUserId.toString();

    const isAdmin =
      ['hr-admin', 'superadmin'].includes(loggedInUser.role);

    // Candidates & employers can delete ONLY themselves
    if (!isSelfDelete && !isAdmin) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({
        message: 'You are not allowed to delete this profile'
      });
    }

    // HR-Admin should delete only candidate/employer
    if (
      loggedInUser.role === 'hr-admin' &&
      !['candidate', 'employer'].includes(targetUser.role)
    ) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({
        message: 'HR-Admin cannot delete admin accounts'
      });
    }

    const deletedUserSnapshot = {
      email: targetUser.email,
      name: targetUser.name,
      role: targetUser.role
    };

    const jobPosts = await JobPost.find({
      $or: [{ employer: targetUserId }, { postedBy: targetUserId }],
    })
      .select('_id')
      .session(session);
    const jobIds = jobPosts.map((job) => job._id);

    const candidateProfiles = await CandidateProfile.find({ candidate: targetUserId })
      .select('_id')
      .session(session);
    const candidateProfileIds = candidateProfiles.map((profile) => profile._id);

    const applicationFilterByUser =
      targetUser.role === 'candidate'
        ? { candidate: targetUserId }
        : { jobPost: { $in: jobIds } };
    const applications = await JobApplication.find(applicationFilterByUser)
      .select('_id')
      .session(session);
    const applicationIds = applications.map((application) => application._id);

    const commonDeleteOps = [
      SavedCandidate.deleteMany({
        $or: [{ employer: targetUserId }, { candidate: targetUserId }],
      }).session(session),
      ResumeDownloadLog.deleteMany({
        $or: [{ employer: targetUserId }, { candidate: targetUserId }],
      }).session(session),
      Notification.deleteMany({
        $or: [
          { user: targetUserId },
          { application: { $in: applicationIds } },
          { jobPost: { $in: jobIds } },
        ],
      }).session(session),
      User.updateMany(
        {},
        {
          $pull: {
            employerIds: targetUserId,
            candidateIds: targetUserId,
            hrAdminIds: targetUserId,
          },
        }
      ).session(session),
    ];

    const candidateDeleteOps = [
      CandidateResume.deleteMany({
        $or: [{ candidate: targetUserId }, { profile: { $in: candidateProfileIds } }],
      }).session(session),
      CandidateCv.deleteMany({ candidate: targetUserId }).session(session),
      CandidateProfile.deleteMany({ candidate: targetUserId }).session(session),
      JobAlert.deleteMany({ candidate: targetUserId }).session(session),
      SavedJob.deleteMany({ candidate: targetUserId }).session(session),
      JobApplication.deleteMany({ candidate: targetUserId }).session(session),
    ];

    const employerDeleteOps = [
      ResumeAlert.deleteMany({ employer: targetUserId }).session(session),
      CompanyProfile.deleteMany({ employer: targetUserId }).session(session),
      SavedCandidate.deleteMany({ employer: targetUserId }).session(session),
      JobApplication.deleteMany({ jobPost: { $in: jobIds } }).session(session),
      SavedJob.deleteMany({ jobPost: { $in: jobIds } }).session(session),
      JobPost.deleteMany({ _id: { $in: jobIds } }).session(session),
    ];

    if (targetUser.role === 'candidate') {
      await Promise.all([...commonDeleteOps, ...candidateDeleteOps]);
    } else if (targetUser.role === 'employer') {
      await Promise.all([...commonDeleteOps, ...employerDeleteOps]);
    } else {
      await Promise.all(commonDeleteOps);
    }

    // Hard delete user so the same email can re-register
    await User.deleteOne({ _id: targetUserId }).session(session);

    await session.commitTransaction();
    session.endSession();

    // Send deletion confirmation email to user
    await sendProfileDeletionEmail({
      recipient: deletedUserSnapshot.email,
      name: deletedUserSnapshot.name,
      role: deletedUserSnapshot.role,
      deletedBy: loggedInUser.email
    });

    if (deletedUserSnapshot.role === 'candidate') {
      const { emailRecipients: adminRecipients } = await getRegistrationAlertAdmins();
      const candidateDeletionAlertRecipients = [
        ...adminRecipients,
        process.env.MAIL_PRIVACY,
        process.env.MAIL_SECURITY,
      ]
        .map((email) => normalizeEmail(email))
        .filter((email, index, list) => isValidEmailAddress(email) && list.indexOf(email) === index);

      await Promise.allSettled(
        candidateDeletionAlertRecipients.map((recipient) =>
          sendCandidateAccountDeletedAlertEmail({
            recipient,
            candidateName: deletedUserSnapshot.name,
            candidateEmail: deletedUserSnapshot.email,
            deletedBy: loggedInUser.email,
            deletedByRole: loggedInUser.role,
          })
        )
      );
    }

    // Send alert to superadmin
    await sendSuperadminAlertEmail({
      superadminEmail: SUPERADMIN_EMAIL,
      userEmail: deletedUserSnapshot.email,
      userRole: deletedUserSnapshot.role,
      message: `User profile deleted by ${loggedInUser.email}`
    });

    return res.status(200).json({
      success: true,
      message: 'User profile deleted successfully'
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    next(error);
  }
};

//* Google OAuth2 Login Handler */
authentication.googleLogin = async (req, res, next) => {
    try {
        // 'role' is passed from the frontend Tabs (candidate or employer)
        const { token: googleToken, role } = req.body; 
        const selectedRole = ['candidate', 'employer'].includes(role) ? role : 'candidate';

        // 1. Verify Google Token
        const ticket = await client.verifyIdToken({
            idToken: googleToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { email, name } = payload;

        // 2. Find existing user by email
        let user = await User.findOne({ email });

        if (!user) {
            // 3. AUTO-REGISTER if user doesn't exist
            // Generate a secure random password (required by your schema)
            const salt = await bcrypt.genSalt(10);
            const randomPass = crypto.randomBytes(16).toString('hex');
            const hashedPassword = await bcrypt.hash(randomPass, salt);

            const freePlanAssignment =
              selectedRole === 'employer'
                ? await getDefaultFreePlanAssignment()
                : {};

            user = new User({
                name: name,
                email: email,
                password: hashedPassword,
                role: selectedRole, // Uses the role from the frontend tab
                status: 'pending',        // Auto-approve verified Google users changed to pending
                isActive: true,
                isDeleted: false,
                ...freePlanAssignment
            });

            await user.save();

            // Send welcome email to new user
            await sendWelcomeEmail({ recipient: email, name });
            // Send alert to superadmin
            await sendSuperadminAlertEmail({
              superadminEmail: SUPERADMIN_EMAIL,
              newUserEmail: email,
              newUserRole: role || 'candidate'
            });
        }

        await assignDefaultFreePlanIfMissing(user);

        // 4. Generate Application JWT (Matches your schema/middleware logic)
        const token = jwt.sign(
            { userId: user._id }, 
            process.env.JWT_SECRET, 
            { expiresIn: process.env.JWT_EXPIRES_IN || '15d' }
        );

        // 5. Return success response to frontend
        res.status(200).json({
            success: true,
            user: {
                token,
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                status: user.status,
                activePaymentPlan: user.activePaymentPlan || null
            }
        });

    } catch (error) {
        console.error("Google Auth Error:", error);
        res.status(401).json({
            success: false,
            message: "Google authentication failed. Please try again."
        });
    }
};

export default authentication;
