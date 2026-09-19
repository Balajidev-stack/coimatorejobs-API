import express, { urlencoded } from 'express';
import cors from 'cors';
// import cookieParser from 'cookie-parser';
import { PORT } from './config/env.js';
import connectToDatabase from './database/mongodb.js';
// import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import authRouter from './routes/auth.routes.js';
import adminRouter from './routes/admin.routes.js';
import errorMiddleware from './middleware/errorHandler.js';
import employerRouter from './routes/employers.routes.js';
import candidateRouter from './routes/candidate.routes.js';
import jobAlertRouter from './routes/jobAlert.routes.js';
import masterRoutes from './routes/master.routes.js';
import pushNotificationRouter from './routes/pushNotification.routes.js';
import indexingRouter from './routes/indexing.routes.js';

import { sendPasswordResetEmail, sendWelcomeEmail, sendSuperadminAlertEmail } from './utils/mailer.js';

import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';

import CandidateCv from './models/candidateCv.model.js';
import { syncSuperadminFromEnv } from './utils/syncSuperadmin.js';
import { approveLegacySelfSignupUsers } from './utils/normalizeLegacyUserStatus.js';

// Get __dirname for ES6 modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// const express = require('express');
const app = express();

// using express-rate-limit or other IP-dependent middleware**
app.set('trust proxy', 1);  // tells Express to trust the first proxy (Render)

// CORS configuration for frontend and backend communication
// Allow requests from specific origins
const allowedOrigins = [
  'http://localhost:3000',                      // Local frontend
  'https://coimbatorejobs.in',         // versal frontend
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS not allowed from this origin'), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true, // If you're using tokens or cookies
}));

// const body = bodyParser.json(urlencoded({ extended: true }));

// Security middleware (e.g., XSS protection)
// app.use(helmet());
// app.use(mongoSanitize());
app.use(express.json({ limit: '1mb' }));

// Serve static files
app.use(express.static('public'));

// Middleware to handle missing image files - serve default if not found
// Fallback for missing company logo images
app.use('/uploads/company', (req, res, next) => {
  const filePath = path.join(__dirname, 'public', 'uploads', 'company', path.basename(req.path));
  
  // Check if requested file exists
  if (!fs.existsSync(filePath)) {
    // Return one of the existing company logos as placeholder
    const defaultLogoPath = path.join(__dirname, 'public', 'uploads', 'company', '0c433527-a5d8-4379-b1e1-dc39c78edabb.png');
    
    if (fs.existsSync(defaultLogoPath)) {
      res.sendFile(defaultLogoPath);
    } else {
      // Fallback to 1x1 transparent PNG if default not available
      res.set('Content-Type', 'image/png');
      res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    }
    return;
  }
  
  next();
});

// Rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
//   standardHeaders: true,
//   legacyHeaders: false,
// });
// app.use('/api', limiter);

// middleware
app.use(express.json({ limit: '1mb' })); // for parsing application/json
app.use(urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded
// app.use(cookieParser()); // for parsing cookies


app.use('/api/v1/auth', authRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/employer-dashboard', employerRouter);
app.use('/api/v1/candidate-dashboard', candidateRouter);
app.use('/api/v1/notification', jobAlertRouter);
app.use('/api/v1/push-notifications', pushNotificationRouter);
app.use('/api/v1/master', masterRoutes);
app.use('/api/v1/indexing', indexingRouter);


// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// cassuing issue with 404
// // Handle 404
// app.use('*', (req, res) => {
//   res.status(404).json({
//     success: false,
//     message: `Route ${req.originalUrl} not found`
//   });
// });

// Test email route
app.get("/test-mail", async (req, res) => {
  await sendWelcomeEmail({ 
    recipient: "aravindakumar3315@gmail.com", 
    name: "Test User" 
  });

  await new Promise(r => setTimeout(r, 1500));

  await sendSuperadminAlertEmail({ 
    superadminEmail: 'saravind406@gmail.com',
    userEmail: "aravindakumar3315@gmail.com",
    userRole: "candidate",
    eventType: "new_registration"
  });

  res.send("Emails sent");
});


// Test S3 upload route
app.post('/test-s3-upload', CandidateCv, (req, res) => {
  if (req.file) {
    res.json({ success: true, file: req.file.location });
  } else {
    res.json({ success: false, message: 'No file' });
  }
});

// common error handler middleware(global error handler)
app.use(errorMiddleware);


app.get('/', (req,res) => { res.json('Hello World!'); });


// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

app.listen(PORT, async() => {
  console.log(`Server is running on port http://localhost:${PORT}`);

  await connectToDatabase();
  await syncSuperadminFromEnv();
  await approveLegacySelfSignupUsers();

});
 

export default app;
