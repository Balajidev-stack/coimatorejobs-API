import puppeteer from 'puppeteer';
import natural from 'natural';
import CandidateResume from '../models/candidateResume.model.js';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors.js';
import fs from 'fs';
import path from 'path';
import { getPrivateFileUrl } from "../utils/s3SignedUrl.js";
// import { candidateUpload } from '../utils/candidateFileUpload.js'; // For portfolio uploads

const candidateResumeController = {};

const findChromeBinaryInDir = (rootDir, depth = 0) => {
    if (!rootDir || depth > 5) return null;

    let entries = [];
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);

        if (entry.isFile() && (entry.name === 'chrome' || entry.name === 'chrome.exe')) {
            return fullPath;
        }

        if (entry.isDirectory()) {
            const found = findChromeBinaryInDir(fullPath, depth + 1);
            if (found) return found;
        }
    }

    return null;
};

const resolveChromeExecutablePath = () => {
    const envPath =
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        process.env.CHROME_PATH ||
        process.env.GOOGLE_CHROME_BIN;

    const candidates = [
        envPath,
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    ].filter(Boolean);

    for (const chromePath of candidates) {
        try {
            if (fs.existsSync(chromePath)) return chromePath;
        } catch {
            // ignore
        }
    }

    const cacheCandidates = [
        path.join(process.cwd(), '.cache', 'puppeteer'),
        path.join(process.env.HOME || '', '.cache', 'puppeteer'),
        path.join(process.env.USERPROFILE || '', '.cache', 'puppeteer'),
    ].filter(Boolean);

    for (const cacheDir of cacheCandidates) {
        const discoveredPath = findChromeBinaryInDir(cacheDir);
        if (discoveredPath) return discoveredPath;
    }

    // Fallback to Puppeteer's managed browser path (downloaded during install)
    try {
        const managedPath =
            typeof puppeteer.executablePath === 'function'
                ? puppeteer.executablePath()
                : null;
        if (managedPath && fs.existsSync(managedPath)) {
            return managedPath;
        }
    } catch {
        // ignore
    }

    return null;
};

const launchPdfBrowser = async () => {
    const executablePath = resolveChromeExecutablePath();
    const commonArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
    ];

    const baseConfig = {
        headless: true,
        args: commonArgs,
    };

    if (executablePath) {
        baseConfig.executablePath = executablePath;
    }

    const launchConfigs = [
        baseConfig,
        { ...baseConfig, headless: 'new' },
        { ...baseConfig, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    ];

    let lastError = null;
    for (const config of launchConfigs) {
        try {
            return await puppeteer.launch(config);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Unable to launch browser for PDF generation');
};

/**
 * Creates a new resume for the authenticated candidate.
 * @param {Object} req - Request object with form data
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
candidateResumeController.createResume = async (req, res, next) => {
    try {
        const candidateId = req.user.id;
        const {
            title, description, template, personalInfo, education, experience, awards, skills, preferences, isPrimary, isActive, profile
        } = req.body;

        // Validate required fields
        if (!title || !description || !profile) {
            throw new BadRequestError('Title, description and profile are required');
        }

        // Limit resumes per candidate (e.g., max 5)
        const resumeCount = await CandidateResume.countDocuments({ candidate: candidateId });
        const resumeLimit = req.user.subscription?.resumeLimit || 20;
        if (resumeCount >= resumeLimit) {
            throw new BadRequestError(`Maximum ${resumeLimit} resumes allowed per candidate`);
        }

        // Handle portfolio uploads
        // const files = req.files || {};
        // const portfolio = [];
        // if (files.portfolio) {
        //     for (const file of files.portfolio) {
        //         portfolio.push({
        //             file: `/uploads/candidate/${file.filename}`,
        //             title: req.body[`portfolioTitle_${file.fieldname}`] || 'Untitled',
        //             description: req.body[`portfolioDesc_${file.fieldname}`] || '',
        //         });
        //     }
        // }

        /**
         * HANDLE S3 PORTFOLIO FILES
         */
        const files = req.files || {};
        const portfolio = [];

        if (files.portfolio) {
        for (const file of files.portfolio) {
            portfolio.push({
            file: file.location, // S3 URL
            title: "Portfolio",
            description: "",
            });
        }
        }

        // Parse arrays and objects if stringified
        const parsedPersonalInfo = typeof personalInfo === 'string' ? JSON.parse(personalInfo) : personalInfo;
        const parsedEducation = typeof education === 'string' ? JSON.parse(education) : education;
        const parsedExperience = typeof experience === 'string' ? JSON.parse(experience) : experience;
        const parsedAwards = typeof awards === 'string' ? JSON.parse(awards) : awards;
        const parsedSkills = typeof skills === 'string' ? JSON.parse(skills) : skills;
        const parsedPreferences = typeof preferences === 'string' ? JSON.parse(preferences) : preferences;


        const parsedIsPrimary = (isPrimary === 'true' || isPrimary === '1' || isPrimary === true);
        const parsedIsActive = (isActive === 'true' || isActive === '1' || isActive === true);


        // If primary, unset other resumes
        if (parsedIsPrimary) {
            await CandidateResume.updateMany(
                { candidate: candidateId },
                { $set: { isPrimary: false } }
            );
        }

        const newResume = new CandidateResume({
            candidate: candidateId,
            profile: profile,
            title,
            description,
            template: template || 'professional',
            personalInfo: parsedPersonalInfo,
            education: parsedEducation,
            experience: parsedExperience,
            awards: parsedAwards,
            skills: parsedSkills,
            portfolio,
            preferences: parsedPreferences,
            isPrimary: parsedIsPrimary || false,
        });

        await newResume.save();

        // Calculate ATS score (simple implementation)
        newResume.atsScore = calculateAtsScore(newResume);
        await newResume.save();

        return res.status(201).json({
            success: true,
            message: 'Resume created successfully',
            resume: newResume,
        });
    } catch (error) {
        // Cleanup portfolio files if error
        if (req.files?.portfolio) {
            for (const file of req.files.portfolio) {
                const filePath = path.join(process.cwd(), 'public', `/uploads/candidate/${file.filename}`);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
        next(error);
    }
};

/**
 * Updates a resume for the authenticated candidate.
 * @param {Object} req - Request object with form data
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
candidateResumeController.updateResume = async (req, res, next) => {
    try {
        const candidateId = req.user.id;
        const resumeId = req.params.id;
        const {
            title, description, template, personalInfo, education, experience, awards, skills, preferences, isPrimary, isActive, profile
        } = req.body;

        const resume = await CandidateResume.findById(resumeId);
        if (!resume || resume.candidate.toString() !== candidateId.toString()) {
            throw new NotFoundError('Resume not found or not yours');
        }

        // Handle portfolio uploads
        // const files = req.files || {};
        // if (files.portfolio) {
        //     // Delete old portfolio files
        //     resume.portfolio.forEach(item => {
        //         const oldFilePath = path.join(process.cwd(), 'public', item.file);
        //         if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
        //     });
        //     // Add new portfolio
        //     const newPortfolio = [];
        //     for (const file of files.portfolio) {
        //         newPortfolio.push({
        //             file: `/uploads/candidate/${file.filename}`,
        //             title: req.body[`portfolioTitle_${file.fieldname}`] || 'Untitled',
        //             description: req.body[`portfolioDesc_${file.fieldname}`] || '',
        //         });
        //     }
        //     resume.portfolio = newPortfolio;
        // }

         /**
         *  HANDLE S3 PORTFOLIO FILES
         */
        const files = req.files || {};

        if (files.portfolio) {
        // Replace portfolio with new S3 files
        resume.portfolio = files.portfolio.map(file => ({
            file: file.location, // S3 URL
            title: "Portfolio",
            description: "",
        }));
        }

        // Parse arrays and objects if stringified
        const parsedPersonalInfo = typeof personalInfo === 'string' ? JSON.parse(personalInfo) : personalInfo;
        const parsedEducation = typeof education === 'string' ? JSON.parse(education) : education;
        const parsedExperience = typeof experience === 'string' ? JSON.parse(experience) : experience;
        const parsedAwards = typeof awards === 'string' ? JSON.parse(awards) : awards;
        const parsedSkills = typeof skills === 'string' ? JSON.parse(skills) : skills;
        const parsedPreferences = typeof preferences === 'string' ? JSON.parse(preferences) : preferences;
        // Correctly parse boolean values
        const parsedIsPrimary = (isPrimary === 'true' || isPrimary === '1' || isPrimary === true);
        const parsedIsActive = (isActive === 'true' || isActive === '1' || isActive === true);



        // Update fields
        resume.profile = profile || resume.profile;
        resume.title = title || resume.title;
        resume.description = description || resume.description;
        resume.template = template || resume.template;
        resume.personalInfo = parsedPersonalInfo || resume.personalInfo;
        resume.education = parsedEducation || resume.education;
        resume.experience = parsedExperience || resume.experience;
        resume.awards = parsedAwards || resume.awards;
        resume.skills = parsedSkills || resume.skills;
        resume.preferences = parsedPreferences || resume.preferences;

        // Update booleans properly
        if (isPrimary !== undefined) {
            resume.isPrimary = parsedIsPrimary;
            if (parsedIsPrimary) {
                // Unset other resumes for this candidate
                await CandidateResume.updateMany(
                    { candidate: candidateId, _id: { $ne: resume._id } },
                    { $set: { isPrimary: false } }
                );
            }
        }
        if (isActive !== undefined) {
            resume.isActive = parsedIsActive;
        }

        await resume.save();

        // Recalculate ATS score
        resume.atsScore = calculateAtsScore(resume);
        await resume.save();

        return res.status(200).json({
            success: true,
            message: 'Resume updated successfully',
            resume,
        });
    } catch (error) {
        // Cleanup portfolio files if error
        if (req.files?.portfolio) {
            for (const file of req.files.portfolio) {
                const filePath = path.join(process.cwd(), 'public', `/uploads/candidate/${file.filename}`);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
        next(error);
    }
};

/**
 * Lists resumes for the authenticated candidate.
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
candidateResumeController.listResumes = async (req, res, next) => {
    try {
        const candidateId = req.user.id;




        const resumes = await CandidateResume.find({ candidate: candidateId, isActive: true })
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            resumes,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Retrieves a single resume for the authenticated candidate.
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
candidateResumeController.getResume = async (req, res, next) => {
    try {
        const candidateId = req.user.id;
        const resumeId = req.params.id;

        const resume = await CandidateResume.findById(resumeId);
        if (!resume || resume.candidate.toString() !== candidateId.toString()) {
            throw new NotFoundError('Resume not found or not yours');
        }

        return res.status(200).json({
            success: true,
            resume,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Deletes a resume for the authenticated candidate.
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
candidateResumeController.deleteResume = async (req, res, next) => {
    try {
        const candidateId = req.user.id;
        const resumeId = req.params.id;

        const resume = await CandidateResume.findById(resumeId);
        if (!resume || resume.candidate.toString() !== candidateId.toString()) {
            throw new NotFoundError('Resume not found or not yours');
        }

        // Delete portfolio files
        resume.portfolio.forEach(item => {
            const filePath = path.join(process.cwd(), 'public', item.file);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });

        await resume.deleteOne();

        return res.status(200).json({
            success: true,
            message: 'Resume deleted successfully',
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Generates PDF CV from resume data.
 * @param {Object} req - Request object with resume ID
 * @param {Object} res - Response object (sends PDF file)
 * @param {Function} next - Next middleware function
 */
candidateResumeController.generatePDF = async (req, res, next) => {
    let browser;
    try {
        const candidateId = req.user.id;
        const resumeId = req.params.id;

        const resume = await CandidateResume.findById(resumeId);
        if (!resume || resume.candidate.toString() !== candidateId.toString()) {
            throw new NotFoundError('Resume not found or not yours');
        }

        // Launch Puppeteer with fallback configs to avoid "Target closed" crashes.
        browser = await launchPdfBrowser();
        const page = await browser.newPage();

        // Generate HTML template
        const htmlContent = generateHTMLTemplate(resume);

        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

        // Set headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        const safeTitle = (resume.title || 'resume').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() || 'resume';
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.pdf"`);

        return res.send(pdfBuffer);
    } catch (error) {
        const errorMsg = String(error?.message || '');
        if (errorMsg.includes('Could not find Chrome')) {
            return res.status(500).json({
                success: false,
                message:
                    'PDF generation failed: Chrome browser is not available on server. Configure CHROME_PATH or install Chrome in runtime.',
            });
        }
        if (errorMsg.includes('Target closed') || errorMsg.includes('Page.printToPDF')) {
            return res.status(500).json({
                success: false,
                message:
                    'PDF generation failed: browser process closed unexpectedly. Please retry once; if it continues, contact support.',
            });
        }
        next(error);
    } finally {
        if (browser) {
            await browser.close().catch(() => null);
        }
    }
};

/**
 * Simple ATS score calculation (can be enhanced with AI later).
 * @param {Object} resume - The resume data
 * @returns {Number} ATS score (0-100)
 */
function calculateAtsScore(resume, jobDescription = '') {
  let score = 0;
  if (resume.personalInfo?.summary) score += 20;
  if (resume.education.length > 0) score += 20;
  if (resume.experience.length > 0) score += 20;
  if (resume.skills.length > 0) score += 20;
  if (resume.portfolio.length > 0) score += 20;
  // Keyword matching
  const tokenizer = new natural.WordTokenizer();
  const resumeText = `${resume.personalInfo?.summary || ''} ${resume.skills.join(' ')}`;
  const resumeTokens = tokenizer.tokenize(resumeText.toLowerCase());
  const jobTokens = tokenizer.tokenize(jobDescription.toLowerCase());
  const matches = resumeTokens.filter(token => jobTokens.includes(token)).length;
  score += Math.min(matches * 2, 20); // Add up to 20 points for keyword matches
  return Math.min(score, 100);
}

/**
 * Helper function to generate HTML template for PDF.
 * @param {Object} resume - The resume data
 * @returns {string} HTML string
 */
function generateHTMLTemplate(resume) {
    const experienceList = Array.isArray(resume.experience) ? resume.experience : [];
    const educationList = Array.isArray(resume.education) ? resume.education : [];
    const skillsList = Array.isArray(resume.skills) ? resume.skills : [];
    const awardsList = Array.isArray(resume.awards) ? resume.awards : [];
    const portfolioList = Array.isArray(resume.portfolio) ? resume.portfolio : [];
    const summary = resume.personalInfo?.summary || resume.description || 'No summary available.';

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>${resume.title}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        h1 { text-align: center; }
        h2 { color: #333; border-bottom: 2px solid #333; }
        ul { list-style-type: disc; padding-left: 20px; }
        .section { margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <h1>${resume.personalInfo?.fullName || 'Candidate Resume'}</h1>
      <p><strong>Professional Title:</strong> ${resume.personalInfo?.professionalTitle || ''}</p>
      <p><strong>Email:</strong> ${resume.personalInfo?.email || ''} | <strong>Phone:</strong> ${resume.personalInfo?.phone || ''}</p>
      <p><strong>LinkedIn:</strong> ${resume.personalInfo?.linkedInUrl || ''} | <strong>GitHub:</strong> ${resume.personalInfo?.githubUrl || ''}</p>
      
      <div class="section">
        <h2>Summary</h2>
        <p>${summary}</p>
      </div>

      <div class="section">
        <h2>Experience</h2>
        <ul>
          ${experienceList.map(exp => `<li><strong>${exp.position || ''}</strong> at ${exp.company || ''} (${exp.years || ''})<br>${exp.description || ''}</li>`).join('')}
        </ul>
      </div>

      <div class="section">
        <h2>Education</h2>
        <ul>
          ${educationList.map(edu => `<li><strong>${edu.degree || ''}</strong> from ${edu.institution || ''} (${edu.years || ''})<br>${edu.description || ''}</li>`).join('')}
        </ul>
      </div>

      <div class="section">
        <h2>Skills</h2>
        <ul>
          ${skillsList.map(skill => `<li>${skill}</li>`).join('')}
        </ul>
      </div>

      <div class="section">
        <h2>Awards</h2>
        <ul>
          ${awardsList.map(award => `<li><strong>${award.title || ''}</strong> (${award.years || ''})<br>${award.description || ''}</li>`).join('')}
        </ul>
      </div>

      <div class="section">
        <h2>Portfolio</h2>
        <ul>
          ${portfolioList.map(item => `<li><strong>${item.title || ''}</strong>: <a href="${item.file || '#'}">${item.file || ''}</a><br>${item.description || ''}</li>`).join('')}
        </ul>
      </div>
    </body>
    </html>
  `;
}

export default candidateResumeController;
