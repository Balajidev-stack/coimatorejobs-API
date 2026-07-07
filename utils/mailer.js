import nodemailer from 'nodemailer';
import ResumeAlert from '../models/resumeAlert.model.js';
import { BadRequestError } from './errors.js';

const isProd = process.env.NODE_ENV === "production";

// mail delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const defaultFromAddress = isProd
  ? (process.env.MAIL_FROM || 'no-reply@coimbatorejobs.in')
  : (process.env.EMAIL_USER || process.env.MAIL_FROM || 'no-reply@coimbatorejobs.in');

let transporter;

if (isProd) {
  // AWS SES in Production
  transporter = nodemailer.createTransport({ 
    host: process.env.SMTP_HOST || 'email-smtp.ap-south-1.amazonaws.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,                    // TLS
    auth: {
      user: process.env.SMTP_USERNAME,
      pass: process.env.SMTP_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,      // Required for SES in some environments
    },
  });
} else {
  // Development â†’ Mailtrap
  // transporter = nodemailer.createTransport({
  //   host: process.env.MAILTRAP_HOST,
  //   port: process.env.MAILTRAP_PORT,
  //   auth: {
  //     user: process.env.MAILTRAP_USER,
  //     pass: process.env.MAILTRAP_PASS,
  //   },
  // });
  // Development â†’ google gmail
   transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
        tls: {
          ciphers: "SSLv3",
          rejectUnauthorized: false, // REQUIRED on Render
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000
  });

}

// Verify connection on startup
transporter.verify((error) => {
  if (error) {
    console.error("Email transporter failed to connect:", error);
  } else {
    console.log(`Email transporter connected successfully (${isProd ? 'AWS SES' : 'Google SMTP'})`);
  }
}); 

// SMTP TRANSPORTER (HYBRID) 
/**
 * commented out mailtrap transporter for development to avoid missing emails due to Gmail's security blocks.old one
 */
// const transporter = nodemailer.createTransport(
//   isProd
//     ? {
//         host: "smtp.gmail.com",
//         port: 587,
//         secure: false,
//         auth: {
//           user: process.env.EMAIL_USER,
//           pass: process.env.EMAIL_PASS,
//         },
//         tls: {
//           ciphers: "SSLv3",
//           rejectUnauthorized: false, // REQUIRED on Render
//         },
//         connectionTimeout: 10000,
//         greetingTimeout: 10000,
//         socketTimeout: 10000
//       }
//     : {

//          // ðŸ§ª DEVELOPMENT â†’ Mailtrap
//         host: process.env.MAILTRAP_HOST,
//         port: process.env.MAILTRAP_PORT,
//         auth: {
//           user: process.env.MAILTRAP_USER,
//           pass: process.env.MAILTRAP_PASS,
//         },
//          pool: false,

//         //  development â†’ Gmail SMTP
//         // host: "smtp.gmail.com",
//         // port: 587,
//         // secure: false,
//         // auth: {
//         //   user: process.env.EMAIL_USER,
//         //   pass: process.env.EMAIL_PASS,
//         // },
//       }
// );


// BASE EMAIL SENDER (DO NOT CHANGE UI)
const sendMail = async ({ to, subject, html, text = '', cc = [], from, attachments = [] }) => {
  try {
    const info = await transporter.sendMail({
      from: from || `"Coimbatore Jobs" <${defaultFromAddress}>`,
      to,
      cc,
      subject,
      text,
      html,
      attachments,
    });

    console.log(`Email sent successfully’ ${to} | MessageId: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error("Email sending failed:", error);
    throw error;
  }
};

const resolveFrontendBaseUrl = () => {
  const raw =
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    'https://coimbatorejobs.in';
  return String(raw).trim().replace(/\/+$/, '');
};

// Function to send job alert email
const sendJobAlertEmail = async ({ recipient, jobTitle, companyName, jobId }) => {
  try {
    if (!recipient) {
      throw new Error('Recipient email is missing');
    }
   
    await sendMail({
      to: recipient,
      subject: `New Job Alert: ${jobTitle}`,
      html: `
        <h2>New Job Opportunity!</h2>
        <p>A new job matching your alert criteria has been posted:</p>
        <p><strong>Job Title:</strong> ${jobTitle}</p>
        <p><strong>Company:</strong> ${companyName}</p>
        <p><a href="${process.env.FRONTEND_URL}/job-single/${jobId}">View Job Details</a></p>
        <p>Update your job alerts or apply directly via your dashboard.</p>
        <p>Best regards,<br><strong>Coimbatore Jobs Team</strong></p>
      `,
      cc: [process.env.MAIL_JOBS] // Provision for other mails (e.g., jobalerts@)
    });
    console.log(`Job alert sent to ${recipient} for ${jobTitle}`);
  } catch (error) {
    console.error(`Failed to send job alert to ${recipient}:`, error);
    throw new BadRequestError('Failed to send job alert email');
  }
};

// Send resume alert email
const sendResumeAlertEmail = async ({
  recipient,
  candidateName,
  jobTitle,
  profileId,
  alert,
  matchScore,
}) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    const frontendBaseUrl = resolveFrontendBaseUrl();
     await sendMail({
      to: recipient,
      subject: `New Resume Match: ${candidateName} for "${alert.title}"`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">New Candidate Match!</h2>
          <p>We found a new candidate who closely matches your alert <strong>"${alert.title}"</strong>.</p>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Candidate:</strong> ${candidateName}</p>
            <p><strong>Job Title:</strong> ${jobTitle}</p>
            <p><strong>Match Score:</strong> ${matchScore ? matchScore.toFixed(1) + '%' : 'N/A'}</p>
            <p><strong>Criteria:</strong></p>
            <ul>
              ${
                alert.criteria.categories?.length
                  ? `<li>Categories: ${alert.criteria.categories.join(', ')}</li>`
                  : ''
              }
              ${
                alert.criteria.location?.city
                  ? `<li>Location: ${alert.criteria.location.city}</li>`
                  : ''
              }
              ${
                alert.criteria.experience
                  ? `<li>Experience: ${alert.criteria.experience}</li>`
                  : ''
              }
              ${
                alert.criteria.skills?.length
                  ? `<li>Skills: ${alert.criteria.skills.join(', ')}</li>`
                  : ''
              }
              ${
                alert.criteria.educationLevels?.length
                  ? `<li>Education: ${alert.criteria.educationLevels.join(', ')}</li>`
                  : ''
              }
            </ul>
          </div>
          <div style="text-align: center; margin-top: 20px;">
            <a href="${frontendBaseUrl}/candidates-single/${profileId}"
               style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              View Candidate Profile
            </a>
          </div>
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
            <p style="color: #64748b; font-size: 14px;">
              Youâ€™re receiving this email because you set up a resume alert on our platform.<br>
              <a href="${frontendBaseUrl}/employers-dashboard/resume-alerts" style="color: #2563eb;">Manage this alert</a> |
              <a href="${frontendBaseUrl}/employers-dashboard/dashboard" style="color: #2563eb;">Notification Settings</a>
            </p>
          </div>
        </div>
      `,
      cc: [process.env.MAIL_SUPPORT] // Provision for other mails (e.g., support@)
    });
    console.log(
      `Resume alert sent to ${recipient} for candidate ${candidateName} (${matchScore?.toFixed(1) || 'N/A'}%)`
    );
    // Update alert stats in DB
    await ResumeAlert.findByIdAndUpdate(alert._id, {
      $inc: { 'stats.emailsSent': 1, 'stats.totalMatches': 1 },
      $set: { 'stats.lastMatch': new Date() },
    });
  } catch (error) {
    console.error(`Failed to send resume alert email to ${recipient}:`, error);
    throw new Error('Failed to send resume alert email');
  }
};

// PASSWORD RESET EMAIL FUNCTION
const sendPasswordResetEmail = async ({ recipient, name, resetUrl }) => {
  try {
    if (!recipient) {
      throw new Error('Recipient email is missing');
    }
   await sendMail({
      to: recipient,
      subject: "Password Reset Request",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; color: #333;">
          <h2 style="color: #2563eb;">Reset Your Password</h2>
          <p>Hello ${name || 'User'},</p>
          <p>You requested to reset your password on Coimbatore Jobs.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="background: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Reset Password
            </a>
          </div>
          <p><small>This link expires in 10 minutes.</small></p>
          <p>If you didn't request this, ignore this email.</p>
          <hr>
          <p style="color: #666; font-size: 12px;">Â© ${new Date().getFullYear()} Coimbatore Jobs by Cispro</p>
        </div>
      `,
      cc: [process.env.MAIL_SECURITY] // Provision for security@ or other
    });
    console.log(`Password reset email sent to ${recipient}`);
  } catch (error) {
    console.error('Password reset email failed:', error);
    throw new Error('Failed to send password reset email');
  }
};

// Candidate/Employer login OTP email
const sendLoginOtpEmail = async ({ recipient, name, otp, expiresInMinutes = 10, role = 'candidate' }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    const roleLabel = role === 'employer' ? 'Employer' : 'Candidate';

    await sendMail({
      to: recipient,
      subject: 'Your Coimbatore Jobs login OTP',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #2563eb;">${roleLabel} Login Verification</h2>
          <p>Hello ${name || roleLabel},</p>
          <p>Your One Time Password (OTP) for login is:</p>
          <div style="margin: 20px 0; text-align: center;">
            <span style="display: inline-block; font-size: 28px; letter-spacing: 8px; font-weight: 700; color: #0f172a; background: #f1f5f9; padding: 14px 20px; border-radius: 10px;">
              ${otp}
            </span>
          </div>
          <p>This OTP expires in <strong>${expiresInMinutes} minutes</strong>.</p>
          <p>If you did not try to login, please reset your password immediately.</p>
          <hr style="margin: 28px 0; border: none; border-top: 1px solid #e2e8f0;" />
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro
          </p>
        </div>
      `,
      cc: [process.env.MAIL_SECURITY]
    });

    console.log(`${roleLabel} login OTP email sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send login OTP to ${recipient}:`, error);
    throw new Error('Failed to send login OTP email');
  }
};

// Send welcome email to new user
const sendWelcomeEmail = async ({ recipient, name }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
     await sendMail({
      from: `"Welcome to Coimbatore Jobs" <${defaultFromAddress}>`,
      to: recipient,
      subject: 'Welcome to Coimbatore Jobs - Your Registration is Successful!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #2563eb;">Welcome, ${name}!</h2>
         
          <p>Thank you for registering with <strong>Coimbatore Jobs</strong>. Your account has been successfully created.</p>
         
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>What's Next?</strong></p>
            <ul style="list-style-type: disc; padding-left: 20px;">
              <li>Complete your profile to get better job matches</li>
              <li>Browse and apply to jobs in Coimbatore</li>
              <li>Set up job alerts for personalized notifications</li>
            </ul>
          </div>
         
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}/login"
               style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Go to Dashboard
            </a>
          </div>
         
          <p>If you have any questions, our support team is here to help at support@coimbatorejobs.com.</p>
         
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
         
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.<br />
            This is an automated message - please do not reply.
          </p>
        </div>
      `,
      cc: [process.env.MAIL_SUPPORT] // Provision for support@ or other
    });
    console.log(`Welcome email sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send welcome email to ${recipient}:`, error);
  }
};

// Helper to get status color & icon
const getStatusStyle = (eventType) => {
  switch (eventType) {
    case 'job_posted':
      return { color: '#2563eb', icon: '🧾', label: 'Job Posted' };
    case 'job_applied':
      return { color: '#7c3aed', icon: '📨', label: 'Job Applied' };
    case 'approved':
      return { color: '#22c55e', icon: 'âœ…', label: 'Approved' };
    case 'rejected':
      return { color: '#ef4444', icon: 'âŒ', label: 'Rejected' };
    case 'deleted':
      return { color: '#ef4444', icon: 'ðŸ—‘ï¸', label: 'Deleted' };
    case 'password_reset':
      return { color: '#f59e0b', icon: 'ðŸ”‘', label: 'Password Reset' };
    case 'create_profile':
      return { color: '#0bf5f5', icon: 'ðŸ‘', label: 'Create Profile' };
    case 'new_registration':
    default:
      return { color: '#3b82f6', icon: 'ðŸ””', label: 'New Registration' };
  }
};

// Unified superadmin alert sender (used for all events)
const sendSuperadminAlertEmail = async ({
  superadminEmail,
  eventType = 'new_registration', // approved, rejected, deleted, password_reset, new_registration, job_posted, job_applied
  userEmail,
  userRole,
  message = '',
  actorEmail = '', // who performed the action (admin/hr-admin)
  dashboardLink = `${process.env.FRONTEND_URL}/super-admin/user-status`
}) => {
  try {
    if (!superadminEmail) throw new Error('Superadmin email not configured');

    const { color, icon, label } = getStatusStyle(eventType);
    const subjectPrefix = {
      new_registration: 'New User Registered',
      approved: 'User / Profile Approved',
      rejected: 'User / Profile Rejected',
      deleted: 'User / Profile Deleted',
      password_reset: 'User Password Reset by Admin',
      job_posted: 'New Job Posted',
      job_applied: 'New Job Application'
    }[eventType] || 'Platform Alert';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
        <h2 style="color: ${color};">${icon} ${label} Alert</h2>
        
        <p>A ${eventType.replace('_', ' ')} event occurred on Coimbatore Jobs:</p>
        
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 5px solid ${color};">
          <p><strong>User Email:</strong> ${userEmail}</p>
          <p><strong>Role:</strong> ${userRole ? userRole.charAt(0).toUpperCase() + userRole.slice(1) : 'User'}</p>
          ${actorEmail ? `<p><strong>Performed by:</strong> ${actorEmail}</p>` : ''}
          <p><strong>Time:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
          ${message ? `<p><strong>Details:</strong> ${message}</p>` : ''}
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${dashboardLink}"
             style="background: ${color}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            View in Dashboard
          </a>
        </div>
        
        <p>This is an automated alert for monitoring and moderation purposes.</p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
        
        <p style="color: #64748b; font-size: 12px; text-align: center;">
          © ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.<br>
          This is a system-generated notification - please do not reply.
        </p>
      </div>
    `;

    await sendMail({
      from: `"System Alert" <${defaultFromAddress}>`,
      to: superadminEmail,
      subject: `${subjectPrefix}: ${userEmail || 'Unknown'} (${userRole || 'User'})`,
      html,
      cc: [process.env.MAIL_GENERAL, process.env.MAIL_SECURITY].filter(Boolean) // only if set
    });

    console.log(`Superadmin alert sent: ${eventType} for ${userEmail}`);
  } catch (error) {
    console.error(`Failed to send superadmin alert (${eventType}):`, error);
  }
};

// Send user status update email (approved/rejected)
const sendUserStatusUpdateEmail = async ({ recipient, name, status, role }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    const isCandidateApproved = role === 'candidate' && status === 'approved';
    await sendMail({
      from: `"Account Update" <${defaultFromAddress}>`,
      to: recipient,
      subject: `Your ${role} Account Status Updated`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: ${status === 'approved' ? '#22c55e' : '#ef4444'};">Account Status Update</h2>
          
          <p>Dear ${name},</p>
          <p>Your ${role} account on Coimbatore Jobs has been <strong>${status}</strong>.</p>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p>
              ${isCandidateApproved
                ? 'Your candidate account has been approved. Please logout and login again, then go to My Profile to create your candidate profile.'
                : status === 'approved' 
                ? 'You can now log in and start using our platform.'
                : 'If you believe this is an error, please contact support.'}
            </p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}${status === 'approved' ? '/login' : '/support'}"
               style="background: ${status === 'approved' ? '#22c55e' : '#ef4444'}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              ${status === 'approved' ? 'Log In Now' : 'Contact Support'}
            </a>
          </div>
          
          <p>Best regards,<br>Coimbatore Jobs Team</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `,
      cc: []
    });
    console.log(`User status update (${status}) sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send status update email to ${recipient}:`, error);
  }
};

// Send password reset success email
const sendPasswordResetSuccessEmail = async ({ recipient, name }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    await sendMail({
      from: `"Security Alert" <${defaultFromAddress}>`,
      to: recipient,
      subject: 'Password Reset Successful',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #22c55e;">Password Reset Complete</h2>
          
          <p>Dear ${name},</p>
          <p>Your password has been successfully reset on Coimbatore Jobs.</p>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p>If you didn't request this change, please contact our security team immediately.</p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}/login"
               style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Log In to Your Account
            </a>
          </div>
          
          <p>For security, we recommend reviewing your recent account activity.</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `,
      cc: [process.env.MAIL_SECURITY] // Provision for report@
    });
    console.log(`Password reset success email sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send password reset success email to ${recipient}:`, error);
  }
};

// Send admin-initiated password reset email
const sendAdminPasswordResetEmail = async ({ recipient, name, adminEmail }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    await sendMail({
      from: `"Admin Notification" <${defaultFromAddress}>`,
      to: recipient,
      subject: 'Your Password Has Been Reset by Admin',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #ef4444;">Password Reset Notification</h2>
          
          <p>Dear ${name},</p>
          <p>Your password has been reset by an administrator (${adminEmail}).</p>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p>Please log in with your new password and change it immediately for security reasons.</p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}/login"
               style="background: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Log In Now
            </a>
          </div>
          
          <p>If you have any concerns, please contact support.</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `,
      cc: [process.env.MAIL_SECURITY, process.env.MAIL_SUPPORT] // Provisions for report@ and support@
    });
    console.log(`Admin password reset email sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send admin password reset email to ${recipient}:`, error);
  }
};

// Send profile deletion email
const sendProfileDeletionEmail = async ({ recipient, name, role, deletedBy }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    await sendMail({
      from: `"Account Update" <${defaultFromAddress}>`,
      to: recipient,
      subject: 'Your Profile Has Been Deleted',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #ef4444;">Profile Deletion Notification</h2>
          
          <p>Dear ${name},</p>
          <p>Your ${role} profile on Coimbatore Jobs has been deleted by ${deletedBy}.</p>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p>If this was not intended, please contact our support team immediately.</p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}/support"
               style="background: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Contact Support
            </a>
          </div>
          
          <p>We're sorry to see you go. If you'd like to create a new account, visit our website.</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `,
      cc: [process.env.MAIL_PRIVACY, process.env.MAIL_SUPPORT] // Provisions for privacy@ and support@
    });
    console.log(`Profile deletion email sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send profile deletion email to ${recipient}:`, error);
  }
};

const sendCandidateAccountDeletedAlertEmail = async ({
  recipient,
  candidateName,
  candidateEmail,
  deletedBy,
  deletedByRole = 'admin',
}) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');

    await sendMail({
      from: `"Account Alert" <${defaultFromAddress}>`,
      to: recipient,
      subject: `Candidate Account Deleted: ${candidateEmail || candidateName || 'Unknown Candidate'}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #ef4444;">Candidate Account Deleted</h2>

          <p>A candidate account has been deleted on Coimbatore Jobs.</p>

          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 5px solid #ef4444;">
            <p><strong>Candidate Name:</strong> ${candidateName || 'N/A'}</p>
            <p><strong>Candidate Email:</strong> ${candidateEmail || 'N/A'}</p>
            <p><strong>Deleted By:</strong> ${deletedBy || 'N/A'}</p>
            <p><strong>Deleted By Role:</strong> ${deletedByRole || 'admin'}</p>
            <p><strong>Deleted At:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
          </div>

          <p>This is an automated account deletion alert for admin, privacy, and security monitoring.</p>

          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />

          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `,
      cc: [],
    });

    console.log(`Candidate deletion alert sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send candidate deletion alert to ${recipient}:`, error);
  }
};

// Send company profile status update email
const sendCompanyProfileStatusEmail = async ({ recipient, name, companyName, status, rejectionReason, dashboardUrl }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    await sendMail({
      from: `"Profile Update" <${defaultFromAddress}>`,
      to: recipient,
      subject: `Your Company Profile Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: ${status === 'approved' ? '#22c55e' : '#ef4444'};">Company Profile Update</h2>
          
          <p>Dear ${name},</p>
          <p>Your company profile for <strong>${companyName}</strong> has been <strong>${status}</strong>.</p>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            ${
              status === 'approved'
                ? '<p>You can now post jobs and manage your company page.</p>'
                : `<p>Reason: ${rejectionReason || 'N/A'}</p><p>Please update and resubmit your profile.</p>`
            }
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardUrl}"
               style="background: ${status === 'approved' ? '#22c55e' : '#ef4444'}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Go to Dashboard
            </a>
          </div>
          
          <p>If you have questions, contact support@coimbatorejobs.com</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `,
      cc: [process.env.MAIL_EMPLOYERS] // Provision for employers@
    });
    console.log(`Company profile status (${status}) sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send company profile status email to ${recipient}:`, error);
  }
};

// Send candidate profile status update email
const sendCandidateProfileStatusEmail = async ({ recipient, name, status, rejectionReason, dashboardUrl }) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    await sendMail({
      from: `"Profile Update" <${defaultFromAddress}>`,
      to: recipient,
      subject: `Your Candidate Profile Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: ${status === 'approved' ? '#22c55e' : '#ef4444'};">Candidate Profile Update</h2>
          
          <p>Dear ${name},</p>
          <p>Your candidate profile has been <strong>${status}</strong>.</p>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            ${
              status === 'approved'
                ? '<p>You can now apply for jobs and be visible to employers.</p>'
                : `<p>Reason: ${rejectionReason || 'N/A'}</p><p>Please update and resubmit your profile.</p>`
            }
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardUrl}"
               style="background: ${status === 'approved' ? '#22c55e' : '#ef4444'}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Go to Dashboard
            </a>
          </div>
          
          <p>If you have questions, contact support@coimbatorejobs.com</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `,
      cc: [process.env.MAIL_SUPPORT] // Provision for support@
    });
    console.log(`Candidate profile status (${status}) sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send candidate profile status email to ${recipient}:`, error);
  }
};

// CONTACT FORM EMAILS 
export const sendContactEmails = async ({
  name,
  email,
  subject,
  message,
  formType,
  ipAddress
}) => {
  // Admin email
  const adminHtml = `
    <h2>ðŸ“© New Contact Form Submission</h2>
    <p><strong>Form Type:</strong> ${formType}</p>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Subject:</strong> ${subject}</p>
    <p><strong>Message:</strong></p>
    <p style="white-space: pre-line">${message}</p>
    <hr />
    <p><strong>IP Address:</strong> ${ipAddress}</p>
    <p><strong>Submitted At:</strong> ${new Date().toLocaleString()}</p>
  `;

  await sendMail({
    to: process.env.MAIL_GENERAL || process.env.SUPERADMIN_EMAIL,
    subject: `New Contact Inquiry (${formType})`,
    html: adminHtml,
    cc: [process.env.MAIL_SUPPORT]
  });

  // User auto-reply
  const userHtml = `
    <p>Hi ${name},</p>
    <p>Thank you for contacting <strong>Coimbatore Jobs</strong>.</p>

    <p>Weâ€™ve received your message and our team will respond within
    <strong>24â€“48 hours</strong>.</p>

    <blockquote style="background:#f8fafc;padding:10px;border-left:4px solid #2563eb">
      ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}
    </blockquote>

    <p>Regards,<br />
    <strong>Coimbatore Jobs Team</strong></p>
  `;

   // Small delay for Mailtrap
  await new Promise(resolve => setTimeout(resolve, 8000)); //remove when in production

  await sendMail({
    to: email,
    subject: 'We received your message â€“ Coimbatore Jobs',
    html: userHtml
  });
};


// Send job application notification email to employer
const sendJobApplicationNotificationEmail = async ({ employerEmail, employerName, candidateName, jobTitle, companyName, dashboardLink }) => {
  try {
    if (!employerEmail) throw new Error('Employer email is missing');
    await sendMail({
      from: `"Job Application Alert" <${defaultFromAddress}>`,
      to: employerEmail,
      subject: `New Application for ${jobTitle} - ${candidateName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #2563eb;">New Job Application Received</h2>
          
          <p>Dear ${employerName},</p>
          <p>A new candidate has applied for your job posting!</p>
          
          <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2563eb;">
            <p style="margin: 5px 0;"><strong>Job Title:</strong> ${jobTitle}</p>
            <p style="margin: 5px 0;"><strong>Company:</strong> ${companyName}</p>
            <p style="margin: 5px 0;"><strong>Candidate Name:</strong> ${candidateName}</p>
            <p style="margin: 5px 0;"><strong>Application Date:</strong> ${new Date().toLocaleDateString()}</p>
          </div>
          
          <p>Review the full application details and candidate resume by clicking the button below:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardLink}"
               style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              View Application
            </a>
          </div>
          
          <p style="color: #64748b; font-size: 14px;">Managing your applications becomes easier on our dashboard. Check it regularly to stay updated with all applications.</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `
    });
    console.log(`Job application notification sent to ${employerEmail}`);
  } catch (error) {
    console.error(`Failed to send job application notification to ${employerEmail}:`, error);
  }
};

// Send job application confirmation email to candidate
const sendCandidateApplicationConfirmationEmail = async ({ candidateEmail, candidateName, jobTitle, companyName, jobId }) => {
  try {
    if (!candidateEmail) throw new Error('Candidate email is missing');
    await sendMail({
      from: `"Application Confirmation" <${defaultFromAddress}>`,
      to: candidateEmail,
      subject: `Application Confirmation - ${jobTitle} at ${companyName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #22c55e;">Application Submitted Successfully</h2>
          
          <p>Dear ${candidateName},</p>
          <p>Thank you for applying! Your application has been successfully submitted.</p>
          
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e;">
            <p style="margin: 5px 0;"><strong>Position:</strong> ${jobTitle}</p>
            <p style="margin: 5px 0;"><strong>Company:</strong> ${companyName}</p>
            <p style="margin: 5px 0;"><strong>Application Date:</strong> ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}</p>
          </div>
          
          <h3 style="color: #1e293b; margin-top: 30px; margin-bottom: 10px;">Next Steps</h3>
          <ul style="color: #475569; line-height: 1.8;">
            <li>The employer will review your application shortly</li>
            <li>If shortlisted, you will receive an email notification</li>
            <li>Keep checking your email regularly for updates on your application status</li>
            <li>Make sure your profile is complete and up-to-date</li>
          </ul>
          
          <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
            <p style="margin: 0; color: #92400e;"><strong>💡 Tip:</strong> Enable email notifications to stay updated on all job-related activities and new opportunities matching your profile.</p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}/candidates-dashboard/applied-jobs"
               style="background: #22c55e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              View Your Applications
            </a>
          </div>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            If you have any questions, feel free to contact our support team.<br/>
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `
    });
    console.log(`Application confirmation sent to ${candidateEmail}`);
  } catch (error) {
    console.error(`Failed to send application confirmation to ${candidateEmail}:`, error);
  }
};

// Send job application status update email to candidate
const sendApplicationStatusUpdateEmail = async ({ candidateEmail, candidateName, jobTitle, companyName, status }) => {
  try {
    if (!candidateEmail) throw new Error('Candidate email is missing');
    
    let statusColor = '#6366f1';
    let statusMessage = '';
    let nextSteps = '';
    
    if (status === 'shortlisted') {
      statusColor = '#22c55e';
      statusMessage = 'Congratulations! Your application has been shortlisted!';
      nextSteps = '<li>The employer will schedule an interview or next round soon</li><li>Check your email regularly for interview details</li><li>Prepare your profile and answers for potential interview questions</li>';
    } else if (status === 'selected') {
      statusColor = '#22c55e';
      statusMessage = 'Great news! You have been selected! 🎉';
      nextSteps = '<li>Review the offer details shared by the employer</li><li>Contact the employer for any clarifications</li><li>Complete the remaining hiring process steps</li>';
    } else if (status === 'rejected') {
      statusColor = '#ef4444';
      statusMessage = 'Thank you for applying';
      nextSteps = '<li>Don\'t be discouraged! This is part of the job search process</li><li>Continue applying to similar positions</li><li>Update your profile with new skills and experience</li><li>Explore other job opportunities on Coimbatore Jobs</li>';
    } else if (status === 'reviewed') {
      statusColor = '#f59e0b';
      statusMessage = 'Your application is under review';
      nextSteps = '<li>The employer is reviewing your application</li><li>You will receive an update soon</li><li>Check your email for further communication</li>';
    }
    
    await sendMail({
      from: `"Application Status Update" <${defaultFromAddress}>`,
      to: candidateEmail,
      subject: `Application Status Update - ${jobTitle} at ${companyName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: ${statusColor};">Application Status: ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
          
          <p>Dear ${candidateName},</p>
          <p>${statusMessage}</p>
          
          <div style="background: ${statusColor === '#ef4444' ? '#fef2f2' : statusColor === '#f59e0b' ? '#fefce8' : '#f0fdf4'}; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${statusColor};">
            <p style="margin: 5px 0;"><strong>Position:</strong> ${jobTitle}</p>
            <p style="margin: 5px 0;"><strong>Company:</strong> ${companyName}</p>
            <p style="margin: 5px 0;"><strong>Status Update Date:</strong> ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}</p>
          </div>
          
          <h3 style="color: #1e293b; margin-top: 30px; margin-bottom: 10px;">Next Steps</h3>
          <ul style="color: #475569; line-height: 1.8;">
            ${nextSteps}
          </ul>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.FRONTEND_URL}/candidates-dashboard/applied-jobs"
               style="background: ${statusColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              View Application Details
            </a>
          </div>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;" />
          
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            Keep checking Coimbatore Jobs for more opportunities<br/>
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `
    });
    console.log(`Application status update sent to ${candidateEmail}`);
  } catch (error) {
    console.error(`Failed to send application status update to ${candidateEmail}:`, error);
  }
};

const sendJobAlertSetupConfirmationEmail = async ({
  recipient,
  name,
  roleLabel,
  locationLabel,
  industryLabel,
}) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');
    const selectedRows = [
      roleLabel
        ? `<p style="margin: 6px 0;"><strong>Role:</strong> ${roleLabel}</p>`
        : "",
      locationLabel
        ? `<p style="margin: 6px 0;"><strong>Location:</strong> ${locationLabel}</p>`
        : "",
      industryLabel
        ? `<p style="margin: 6px 0;"><strong>Industry:</strong> ${industryLabel}</p>`
        : "",
    ]
      .filter(Boolean)
      .join("");

    await sendMail({
      to: recipient,
      subject: 'Job Alert Created Successfully',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #2563eb;">Job Alert is Active</h2>
          <p>Hello ${name || 'Candidate'},</p>
          <p>Your job alert has been created. We will notify you instantly when matching jobs are posted.</p>
          ${
            selectedRows
              ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px; margin: 18px 0;">${selectedRows}</div>`
              : ""
          }
          <p>Thanks,<br><strong>Coimbatore Jobs Team</strong></p>
        </div>
      `,
    });
  } catch (error) {
    console.error(`Failed to send job alert setup email to ${recipient}:`, error);
  }
};

// Send job post confirmation email to employer (only when employer posts directly)
const sendEmployerJobPostedEmail = async ({ recipient, employerName, jobTitle, companyName, dashboardLink }) => {
  try {
    if (!recipient) throw new Error('Employer email is missing');
    await sendMail({
      from: `"Job Post Confirmation" <${defaultFromAddress}>`,
      to: recipient,
      subject: `Job Posted Successfully - ${jobTitle}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #22c55e;">Your Job Post is Live</h2>
          <p>Dear ${employerName || 'Employer'},</p>
          <p>Your new job has been posted successfully on Coimbatore Jobs.</p>
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e;">
            <p style="margin: 5px 0;"><strong>Job Title:</strong> ${jobTitle}</p>
            <p style="margin: 5px 0;"><strong>Company:</strong> ${companyName}</p>
            <p style="margin: 5px 0;"><strong>Posted On:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardLink}"
               style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              View Manage Jobs
            </a>
          </div>
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
          </p>
        </div>
      `
    });
    console.log(`Employer job-post confirmation sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send employer job-post confirmation to ${recipient}:`, error);
  }
};

const formatReceiptCurrency = (amount = 0, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number(amount || 0));

const sendPlanReceiptEmail = async ({
  recipient,
  employerName,
  planName,
  amount = 0,
  currency = 'INR',
  receipt,
  paymentId,
  activatedAt,
  expiresAt,
  paymentMode,
  attachments = [],
}) => {
  try {
    if (!recipient) throw new Error('Recipient email is missing');

    const activatedDate = activatedAt
      ? new Date(activatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const expiryDate = expiresAt
      ? new Date(expiresAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
      : 'No expiry';

    await sendMail({
      from: `"Coimbatore Jobs Receipts" <${defaultFromAddress}>`,
      to: recipient,
      subject: `Payment Receipt - ${planName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #1f2937;">
          <div style="background: #6b3f2a; color: #ffffff; padding: 22px 26px; border-radius: 14px 14px 0 0;">
            <h2 style="margin: 0; font-size: 24px;">Coimbatore Jobs Receipt</h2>
            <p style="margin: 8px 0 0; color: #f6d7bd;">Your employer plan has been activated successfully.</p>
          </div>
          <div style="border: 1px solid #eadfd2; border-top: 0; padding: 26px; border-radius: 0 0 14px 14px;">
            <p>Dear ${employerName || 'Employer'},</p>
            <p>Thank you for choosing the <strong>${planName}</strong> plan.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 22px 0;">
              <tbody>
                <tr>
                  <td style="padding: 12px; border: 1px solid #f0e7dc; background: #fffaf4;"><strong>Receipt No</strong></td>
                  <td style="padding: 12px; border: 1px solid #f0e7dc;">${receipt || '-'}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border: 1px solid #f0e7dc; background: #fffaf4;"><strong>Plan</strong></td>
                  <td style="padding: 12px; border: 1px solid #f0e7dc;">${planName}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border: 1px solid #f0e7dc; background: #fffaf4;"><strong>Amount</strong></td>
                  <td style="padding: 12px; border: 1px solid #f0e7dc;">${formatReceiptCurrency(amount, currency)}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border: 1px solid #f0e7dc; background: #fffaf4;"><strong>Payment ID</strong></td>
                  <td style="padding: 12px; border: 1px solid #f0e7dc;">${paymentId || (Number(amount) > 0 ? '-' : 'Free activation')}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border: 1px solid #f0e7dc; background: #fffaf4;"><strong>Activated On</strong></td>
                  <td style="padding: 12px; border: 1px solid #f0e7dc;">${activatedDate}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border: 1px solid #f0e7dc; background: #fffaf4;"><strong>Valid Till</strong></td>
                  <td style="padding: 12px; border: 1px solid #f0e7dc;">${expiryDate}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border: 1px solid #f0e7dc; background: #fffaf4;"><strong>Mode</strong></td>
                  <td style="padding: 12px; border: 1px solid #f0e7dc;">${paymentMode || 'Online'}</td>
                </tr>
              </tbody>
            </table>
            <p style="color: #64748b; font-size: 13px;">This is an automatically generated receipt from Coimbatore Jobs.</p>
            <p style="color: #64748b; font-size: 12px; text-align: center; margin-top: 26px;">
              &copy; ${new Date().getFullYear()} Coimbatore Jobs by Cispro. All rights reserved.
            </p>
          </div>
        </div>
      `,
      attachments,
    });
    console.log(`Plan receipt email sent to ${recipient}`);
  } catch (error) {
    console.error(`Failed to send plan receipt email to ${recipient}:`, error);
  }
};

export { sendJobAlertEmail, sendJobAlertSetupConfirmationEmail, sendResumeAlertEmail, sendPasswordResetEmail, sendLoginOtpEmail, sendWelcomeEmail, sendSuperadminAlertEmail, sendUserStatusUpdateEmail, sendPasswordResetSuccessEmail, sendAdminPasswordResetEmail, sendProfileDeletionEmail, sendCandidateAccountDeletedAlertEmail, sendCompanyProfileStatusEmail, sendCandidateProfileStatusEmail, sendJobApplicationNotificationEmail, sendCandidateApplicationConfirmationEmail, sendApplicationStatusUpdateEmail, sendEmployerJobPostedEmail, sendPlanReceiptEmail };

