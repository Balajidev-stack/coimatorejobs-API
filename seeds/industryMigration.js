import mongoose from 'mongoose';
import CompanyProfile from "../models/companyProfile.model.js";
import Industry from '../models/industry.model.js';
import dotenv from 'dotenv';
import connectToDatabase from '../database/mongodb.js';

const generateSlug = (name) =>
  String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const migrateIndustry = async () => {
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let missingCount = 0;

  const shouldCreateMissing =
    process.env.MIGRATE_CREATE_MISSING_INDUSTRY === 'true' ||
    process.argv.includes('--create-missing');

  const isDryRun =
    process.env.MIGRATE_DRY_RUN === 'true' ||
    process.argv.includes('--dry-run');

  const normalize = (value) =>
    String(value || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const findIndustryByName = async (rawName) => {
    const normalized = normalize(rawName);
    const industries = await Industry.find({}, { _id: 1, name: 1, slug: 1 }).lean();
    return (
      industries.find((item) => normalize(item.name) === normalized) || null
    );
  };

  let connection;
  try {
    dotenv.config();
    connection = await connectToDatabase();

    const companies = await CompanyProfile.find({
      industry: { $type: "string" }
    });

    for (const company of companies) {
      const rawIndustry = String(company.industry || '').trim();
      if (!rawIndustry) {
        skippedCount++;
        continue;
      }

      let industryDoc = await findIndustryByName(rawIndustry);

      if (!industryDoc && shouldCreateMissing) {
        const slug = generateSlug(rawIndustry);
        if (slug) {
          industryDoc = await Industry.findOneAndUpdate(
            { slug },
            {
              $set: {
                name: rawIndustry,
                slug,
                isActive: true,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          ).lean();
          createdCount++;
        }
      }

      if (industryDoc) {
        if (!isDryRun) {
          company.industry = industryDoc._id;
          await company.save();
        }
        updatedCount++;
        console.log(`Updated: ${company.companyName} -> ${industryDoc.name}`);
      } else {
        missingCount++;
        console.log(`Industry not found for: ${company.companyName} ("${rawIndustry}")`);
      }
    }

    console.log('\nIndustry migration completed');
    console.log(`Updated companies: ${updatedCount}`);
    console.log(`Missing industries: ${missingCount}`);
    console.log(`Created industries: ${createdCount}`);
    console.log(`Skipped: ${skippedCount}`);
    console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'WRITE'}`);

    process.exit(0);
  } catch (error) {
    console.error('Industry migration failed:', error);
    process.exit(1);
  } finally {
    if (connection && mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
  }
};

migrateIndustry();
