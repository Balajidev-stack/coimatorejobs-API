// middleware/auth.js
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env.js';
import User from '../models/user.model.js';
import { isEmployerLike, isPlatformAdmin } from '../utils/roleHelper.js';

const normalizeAuthRole = (role = '') => (role === 'sub-admin' ? 'hr-admin' : role);

// Authenticate user
export const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized - No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // const user = await User.findById(decoded.userId);
    
    // Fetch full user context
    const user = await User.findById(decoded.userId).select(
      '_id name email role employerIds candidateIds createdBy isActive parentEmployer employerAccessTabs employerRoleName employerRoleRemoved'
    );

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Unauthorized - User is not active or not found' });
    }

    const employerOwnerId = user.role === 'employer' ? (user.parentEmployer || user._id) : null;
    req.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: normalizeAuthRole(user.role),
      rawRole: user.role,
      createdBy: user.createdBy || null,
      employerIds: user.employerIds || [],
      candidateIds: user.candidateIds || [],
      parentEmployer: user.parentEmployer || null,
      employerOwnerId,
      employerAccessTabs: user.employerAccessTabs || [],
      employerRoleName: user.employerRoleName || '',
      employerRoleRemoved: user.employerRoleRemoved || false,
    };
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

// General role authorization
export const authorize = (allowedRoles = []) => (req, res, next) => {
  const allowed = allowedRoles.flatMap((role) => role === 'hr-admin' ? ['hr-admin', 'sub-admin'] : [role]);
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden - Insufficient permissions' });
  }
  next();
};

// Shortcut: Any employer-like role (employer, hr-admin, superadmin)
export const authorizeEmployerLike = () => (req, res, next) => {
    // console.log("tttttttttttttttttt", req.user);
    
  if (!req.user || !isEmployerLike(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden - Employer or HR access required' });
  }
  next();
};

// Superadmin only
export const authorizePlatformAdmin = () => (req, res, next) => {
  if (!req.user || !isPlatformAdmin(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden - Superadmin access required' });
  }
  next();
};

// Optional authenticate (allows guests but reads token if present)
export const optionalAuthenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // No token → guest user
  if (!authHeader?.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(decoded.userId).select(
      '_id name email role employerIds candidateIds createdBy isActive parentEmployer employerAccessTabs employerRoleName employerRoleRemoved'
    );

    if (!user || !user.isActive) {
      req.user = null;
      return next();
    }

    const employerOwnerId = user.role === 'employer' ? (user.parentEmployer || user._id) : null;
    req.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: normalizeAuthRole(user.role),
      rawRole: user.role,
      createdBy: user.createdBy || null,
      employerIds: user.employerIds || [],
      candidateIds: user.candidateIds || [],
      parentEmployer: user.parentEmployer || null,
      employerOwnerId,
      employerAccessTabs: user.employerAccessTabs || [],
      employerRoleName: user.employerRoleName || '',
      employerRoleRemoved: user.employerRoleRemoved || false
    };

  } catch (error) {
    req.user = null;
  }

  next();
};
