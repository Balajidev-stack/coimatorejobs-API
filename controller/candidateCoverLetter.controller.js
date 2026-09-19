import CandidateCoverLetter from '../models/candidateCoverLetter.model.js';
import { BadRequestError, NotFoundError } from '../utils/errors.js';

const candidateCoverLetterController = {};

const pickCoverLetterFields = (body = {}) => ({
  title: body.title,
  template: body.template || '',
  fullName: body.fullName || '',
  jobTitle: body.jobTitle || '',
  email: body.email || '',
  city: body.city || body.address || '',
  mobileNumber: body.mobileNumber || '',
  company: body.company || '',
  managerName: body.managerName || '',
  role: body.role || '',
  content: body.content || '',
  html: body.html || '',
  isActive: body.isActive === undefined
    ? true
    : (body.isActive === true || body.isActive === 'true' || body.isActive === '1'),
});

candidateCoverLetterController.createCoverLetter = async (req, res, next) => {
  try {
    const candidateId = req.user.id;
    const fields = pickCoverLetterFields(req.body);

    if (!fields.title) {
      throw new BadRequestError('Title is required');
    }

    const coverLetter = await CandidateCoverLetter.create({
      candidate: candidateId,
      ...fields,
    });

    return res.status(201).json({
      success: true,
      message: 'Cover letter created successfully',
      coverLetter,
    });
  } catch (error) {
    next(error);
  }
};

candidateCoverLetterController.updateCoverLetter = async (req, res, next) => {
  try {
    const candidateId = req.user.id;
    const coverLetter = await CandidateCoverLetter.findById(req.params.id);

    if (!coverLetter || coverLetter.candidate.toString() !== candidateId.toString()) {
      throw new NotFoundError('Cover letter not found or not yours');
    }

    const fields = pickCoverLetterFields(req.body);
    if (!fields.title) {
      throw new BadRequestError('Title is required');
    }

    Object.assign(coverLetter, fields);
    await coverLetter.save();

    return res.status(200).json({
      success: true,
      message: 'Cover letter updated successfully',
      coverLetter,
    });
  } catch (error) {
    next(error);
  }
};

candidateCoverLetterController.listCoverLetters = async (req, res, next) => {
  try {
    const coverLetters = await CandidateCoverLetter.find({
      candidate: req.user.id,
      isActive: true,
    }).sort({ updatedAt: -1 });

    return res.status(200).json({
      success: true,
      coverLetters,
    });
  } catch (error) {
    next(error);
  }
};

candidateCoverLetterController.getCoverLetter = async (req, res, next) => {
  try {
    const candidateId = req.user.id;
    const coverLetter = await CandidateCoverLetter.findById(req.params.id);

    if (!coverLetter || coverLetter.candidate.toString() !== candidateId.toString()) {
      throw new NotFoundError('Cover letter not found or not yours');
    }

    return res.status(200).json({
      success: true,
      coverLetter,
    });
  } catch (error) {
    next(error);
  }
};

candidateCoverLetterController.deleteCoverLetter = async (req, res, next) => {
  try {
    const candidateId = req.user.id;
    const coverLetter = await CandidateCoverLetter.findById(req.params.id);

    if (!coverLetter || coverLetter.candidate.toString() !== candidateId.toString()) {
      throw new NotFoundError('Cover letter not found or not yours');
    }

    await coverLetter.deleteOne();

    return res.status(200).json({
      success: true,
      message: 'Cover letter deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

export default candidateCoverLetterController;
