// seeds/categories.seed.js
import mongoose from 'mongoose';
import Industry from '../models/industry.model.js';
import FunctionalArea from '../models/functionalArea.model.js';
import Role from '../models/role.model.js';
import Location from '../models/location.model.js';
import Skill from '../models/skill.model.js';
import dotenv from 'dotenv';
import connectToDatabase from '../database/mongodb.js';

dotenv.config();
await connectToDatabase();

const generateSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

//industry data
const industriesData = [
  { name: 'Aviation & Aerospace', keywords: ['aviation jobs', 'aerospace engineering jobs', 'pilot jobs', 'aircraft maintenance jobs', 'airline careers'] },
  { name: 'Automotive', keywords: ['automotive jobs', 'car manufacturing careers', 'vehicle engineer vacancies', 'auto sales openings'] }, // ← NEW
  { name: 'Banking / Insurance / Financial Services', keywords: ['banking jobs', 'insurance jobs', 'financial services careers', 'BFSI jobs', 'bank PO jobs', 'insurance agent vacancies'] },
  { name: 'Beauty, Fitness & Personal Care', keywords: ['beauty jobs', 'fitness trainer jobs', 'salon jobs', 'spa careers', 'personal trainer openings', 'wellness jobs'] },
  { name: 'Construction', keywords: ['construction jobs', 'civil engineering jobs', 'site engineer vacancies', 'project manager construction', 'building construction careers'] },
  { name: 'Consulting', keywords: ['consulting jobs', 'management consulting careers', 'business consultant vacancies', 'strategy consulting openings', 'IT consulting jobs'] },
  { name: 'Education & Training', keywords: ['education jobs', 'teaching careers', 'academic vacancies', 'school jobs', 'college lecturer openings'] }, // ← NEW
  { name: 'Energy & Mining', keywords: ['energy jobs', 'oil and gas jobs', 'mining engineer vacancies', 'power sector careers', 'renewable energy jobs'] },
  { name: 'Healthcare & Life Sciences', keywords: ['healthcare jobs', 'doctor jobs', 'nurse vacancies', 'hospital staff openings', 'pharma jobs', 'medical jobs', 'life sciences careers'] },

  { name: 'Hospitality', keywords: ['hospitality jobs', 'hotel jobs', 'restaurant careers', 'tourism vacancies', 'chef jobs', 'front office openings'] },
  { name: 'IT / Software', keywords: ['IT jobs', 'software jobs', 'developer vacancies', 'IT careers in India', 'tech jobs', 'software engineer openings', 'programming jobs'] },
  { name: 'Logistics / Transportation', keywords: ['logistics jobs', 'transportation jobs', 'supply chain careers', 'warehouse jobs', 'driver vacancies', 'freight forwarding openings'] },
  { name: 'Manufacturing', keywords: ['manufacturing jobs', 'production jobs', 'factory vacancies', 'manufacturing engineer careers', 'assembly line openings'] },
  { name: 'Media / Entertainment', keywords: ['media jobs', 'entertainment careers', 'journalism vacancies', 'film jobs', 'content creator openings', 'TV radio jobs'] },
  { name: 'Pharmaceuticals', keywords: ['pharma jobs', 'pharmaceutical careers', 'medical representative vacancies', 'drug inspector openings', 'pharmacist jobs'] },
  { name: 'Retail & eCommerce', keywords: ['retail jobs', 'ecommerce jobs', 'store manager vacancies', 'online sales careers', 'merchandising openings'] },
  { name: 'Telecommunications', keywords: ['telecom jobs', 'network engineer vacancies', 'telecommunications careers', 'BSS OSS jobs', 'mobile network openings'] },
  { name: 'Textile & Garments', keywords: ['textile jobs', 'garment industry vacancies', 'fashion designer careers', 'apparel manufacturing openings', 'textile engineer jobs'] },
  { name: 'Other', keywords: ['miscellaneous jobs', 'general vacancies', 'other sector careers', 'diverse job openings'] },
];

// GLOBAL FUNCTIONAL AREAS (appear in ALL industries)
const globalFunctionalAreasData = [
  { name: 'Human Resources', isGlobal: true, keywords: ['HR jobs', 'human resources', 'recruitment', 'talent acquisition', 'HR manager', 'HR executive'] },
  { name: 'Finance & Accounting', isGlobal: true, keywords: ['finance jobs', 'accounting jobs', 'CA jobs', 'accountant', 'financial analyst', 'audit jobs'] },
  { name: 'Administration', isGlobal: true, keywords: ['admin jobs', 'administrative jobs', 'office administration', 'admin executive', 'office manager'] },
  { name: 'Business Analysis', isGlobal: false, keywords: ['business analyst jobs', 'requirements gathering vacancies', 'process improvement careers'] }, // ← NEW

  { name: 'Sales & Business Development', isGlobal: true, keywords: ['sales jobs', 'business development', 'sales executive', 'BDM', 'sales manager', 'business growth'] },
  { name: 'Marketing', isGlobal: true, keywords: ['marketing jobs', 'digital marketing', 'brand marketing', 'communication jobs', 'marketing manager',  'SEO SEM vacancies', 'social media marketing careers', 'content marketing openings'] },
  { name: 'Operations', isGlobal: true, keywords: ['operations jobs', 'operations management', 'operations head', 'operational excellence', 'process improvement'] },
  { name: 'Customer Support & Service', isGlobal: true, keywords: ['customer support jobs', 'customer service', 'call center', 'helpdesk', 'customer care'] },
  { name: 'Procurement & Supply Chain', isGlobal: true, keywords: ['procurement jobs', 'supply chain', 'purchase jobs', 'logistics', 'inventory management'] },
  { name: 'Quality Assurance', isGlobal: true, keywords: ['QA jobs', 'quality assurance', 'quality control', 'QC jobs', 'testing jobs'] },
  { name: 'Legal & Compliance', isGlobal: true, keywords: ['legal jobs', 'compliance jobs', 'legal advisor', 'compliance officer', 'regulatory affairs'] },
  { name: 'Information Technology (IT)', isGlobal: true, keywords: ['IT jobs', 'IT support', 'system administrator', 'IT manager', 'technical support'] },
  { name: 'Project & Program Management', isGlobal: true, keywords: ['project manager jobs', 'project management', 'PMO', 'project coordinator', 'program manager'] },
  { name: 'Research & Development', isGlobal: true, keywords: ['R&D jobs', 'research scientist', 'development engineer', 'innovation', 'lab research'] },
  { name: 'Health, Safety & Environment (HSE)', isGlobal: true, keywords: ['HSE jobs', 'safety officer', 'environmental engineer', 'HSE manager', 'safety supervisor'] },
  { name: 'Training & Development', isGlobal: true, keywords: ['training jobs', 'corporate trainer', 'learning development', 'soft skills trainer', 'training manager'] },
];

// INDUSTRY-SPECIFIC FUNCTIONAL AREAS
const industrySpecificFunctionalAreasData = [
  // IT / Software
  { name: 'Software Development', industryName: 'IT / Software', keywords: ['software developer jobs', 'programming jobs', 'coding jobs', 'software engineer', 'app development'] },
  { name: 'Data Science & Analytics', industryName: 'IT / Software', keywords: ['data science jobs', 'data analyst', 'business intelligence', 'machine learning', 'big data'] },
  { name: 'Cyber Security', industryName: 'IT / Software', keywords: ['cyber security jobs', 'information security', 'security analyst', 'ethical hacker', 'security engineer'] },
  { name: 'Cloud & DevOps', industryName: 'IT / Software', keywords: ['cloud jobs', 'devops engineer', 'aws azure', 'cloud architect', 'site reliability'] },
  { name: 'UX/UI Design', industryName: 'IT / Software', keywords: ['ui ux jobs', 'user experience', 'user interface', 'product designer', 'ux researcher'] },
  { name: 'IT Infrastructure', industryName: 'IT / Software', keywords: ['network engineer jobs', 'system administrator', 'IT infrastructure', 'network security', 'server admin'] },
  { name: 'Artificial Intelligence (AI) & Machine Learning', industryName: 'IT / Software', keywords: ['ai engineer jobs', 'machine learning engineer', 'nlp engineer', 'computer vision engineer', 'ai researcher'] },
  { name: 'Web Development', industryName: 'IT / Software', keywords: ['web developer jobs', 'ui developer', 'frontend web jobs', 'web application developer'] },
  { name: 'Mobile App Development', industryName: 'IT / Software', keywords: ['android developer jobs', 'ios developer jobs', 'flutter developer jobs', 'react native developer jobs'] },
  { name: 'Cybersecurity', industryName: 'IT / Software', keywords: ['cybersecurity analyst jobs', 'ethical hacker jobs', 'penetration tester jobs', 'soc analyst jobs'] },
  { name: 'Cloud Computing', industryName: 'IT / Software', keywords: ['cloud engineer jobs', 'cloud architect jobs', 'cloud security engineer jobs', 'cloud administrator jobs'] },
  { name: 'Database Management', industryName: 'IT / Software', keywords: ['database administrator jobs', 'database developer jobs', 'data architect jobs', 'sql developer jobs'] },
  { name: 'DevOps & Automation', industryName: 'IT / Software', keywords: ['devops engineer jobs', 'automation engineer jobs', 'sre jobs', 'ci cd engineer jobs'] },
  { name: 'Networking & Infrastructure', industryName: 'IT / Software', keywords: ['network engineer jobs', 'network administrator jobs', 'systems engineer jobs', 'infrastructure architect jobs'] },
  { name: 'IT Support & Helpdesk', industryName: 'IT / Software', keywords: ['it support specialist jobs', 'helpdesk technician jobs', 'technical support engineer jobs', 'desktop support engineer jobs'] },
  { name: 'UI/UX Design', industryName: 'IT / Software', keywords: ['ui designer jobs', 'ux designer jobs', 'interaction designer jobs', 'ux researcher jobs'] },
  { name: 'Quality Assurance & Testing', industryName: 'IT / Software', keywords: ['qa engineer jobs', 'test engineer jobs', 'automation tester jobs', 'manual tester jobs'] },
  { name: 'Blockchain Technology', industryName: 'IT / Software', keywords: ['blockchain developer jobs', 'smart contract developer jobs', 'blockchain architect jobs', 'crypto analyst jobs'] },
  { name: 'Internet of Things (IoT)', industryName: 'IT / Software', keywords: ['iot engineer jobs', 'embedded systems engineer jobs', 'firmware developer jobs', 'iot architect jobs'] },
  { name: 'Game Development', industryName: 'IT / Software', keywords: ['game developer jobs', 'game designer jobs', 'unity developer jobs', 'unreal engine developer jobs'] },
  { name: 'ERP & Enterprise Systems', industryName: 'IT / Software', keywords: ['sap consultant jobs', 'erp developer jobs', 'erp functional analyst jobs', 'sap abap developer jobs'] },
  { name: 'Digital Marketing (IT Sector)', industryName: 'IT / Software', keywords: ['seo analyst jobs', 'seo specialist jobs', 'ppc specialist jobs', 'google ads expert jobs'] },

  //   Education & Training
  { name: 'Education & Training',  industryName: 'Education & Training', keywords: ['teaching jobs', 'education careers', 'trainer vacancies', 'lecturer openings', 'school teacher jobs'] },

  
  // Healthcare & Life Sciences
  { name: 'Clinical & Medical', industryName: 'Healthcare & Life Sciences', keywords: ['doctor jobs', 'nurse jobs', 'medical officer', 'clinical jobs', 'medical practitioner'] },
  { name: 'Healthcare Support', industryName: 'Healthcare & Life Sciences', keywords: ['hospital staff', 'medical technician', 'lab technician', 'pharmacist', 'radiology technician'] },
  { name: 'Medical Research', industryName: 'Healthcare & Life Sciences', keywords: ['medical research jobs', 'clinical research', 'biotech research', 'lab research', 'research scientist'] },
  { name: 'Hospital Administration', industryName: 'Healthcare & Life Sciences', keywords: ['hospital admin jobs', 'healthcare management', 'hospital director', 'medical superintendent'] },
  
  // Banking / Insurance / Financial Services
  { name: 'Banking Operations', industryName: 'Banking / Insurance / Financial Services', keywords: ['bank operations', 'loan processing', 'bank teller', 'relationship manager', 'credit analyst'] },
  { name: 'Insurance Operations', industryName: 'Banking / Insurance / Financial Services', keywords: ['insurance jobs', 'insurance agent', 'insurance surveyor', 'claims processing', 'underwriter'] },
  { name: 'Investment Banking', industryName: 'Banking / Insurance / Financial Services', keywords: ['investment banking jobs', 'mergers acquisitions', 'equity research', 'portfolio management'] },
  { name: 'Wealth Management', industryName: 'Banking / Insurance / Financial Services', keywords: ['wealth management jobs', 'financial planning', 'investment advisor', 'private banking'] },
  
  // Manufacturing
  { name: 'Production & Manufacturing', industryName: 'Manufacturing', keywords: ['production jobs', 'manufacturing jobs', 'production supervisor', 'shop floor', 'manufacturing operations'] },
  { name: 'Mechanical Engineering', industryName: 'Manufacturing', keywords: ['mechanical engineer jobs', 'design engineer', 'production engineer', 'maintenance engineer', 'mechanical design'] },
  { name: 'Industrial Engineering', industryName: 'Manufacturing', keywords: ['industrial engineer jobs', 'process engineer', 'manufacturing engineer', 'plant engineer'] },
  { name: 'Maintenance & Repair', industryName: 'Manufacturing', keywords: ['maintenance jobs', 'repair technician', 'equipment maintenance', 'plant maintenance'] },
  
  // Construction
  { name: 'Civil Engineering', industryName: 'Construction', keywords: ['civil engineer jobs', 'site engineer', 'structural engineer', 'construction engineer', 'site supervisor'] },
  { name: 'Architecture & Interior Design', industryName: 'Construction', keywords: ['architect jobs', 'interior designer', 'landscape architect', 'building designer'] },
  { name: 'Project Management (Construction)', industryName: 'Construction', keywords: ['construction project manager', 'site manager', 'construction supervisor', 'project coordinator'] },
  { name: 'Quantity Surveying', industryName: 'Construction', keywords: ['quantity surveyor jobs', 'cost estimator', 'billing engineer', 'contracts manager'] },
  
  // Retail & eCommerce
  { name: 'Store Operations', industryName: 'Retail & eCommerce', keywords: ['store operations', 'retail sales', 'visual merchandising', 'store supervisor', 'retail associate'] },
  { name: 'eCommerce Management', industryName: 'Retail & eCommerce', keywords: ['ecommerce jobs', 'online store manager', 'ecommerce executive', 'digital store management'] },
  { name: 'Merchandising', industryName: 'Retail & eCommerce', keywords: ['merchandising jobs', 'buyer', 'visual merchandiser', 'category manager'] },
  { name: 'Warehouse Operations', industryName: 'Retail & eCommerce', keywords: ['warehouse jobs', 'inventory management', 'warehouse supervisor', 'storekeeper'] },
  
  // Hospitality
  { name: 'Hotel Operations', industryName: 'Hospitality', keywords: ['hotel jobs', 'front office', 'housekeeping', 'hotel management', 'guest relations'] },
  { name: 'Food & Beverage', industryName: 'Hospitality', keywords: ['F&B jobs', 'chef jobs', 'restaurant manager', 'food service', 'beverage manager'] },
  { name: 'Travel & Tourism', industryName: 'Hospitality', keywords: ['travel jobs', 'tour operator', 'travel agent', 'tourism manager', 'holiday planner'] },
  { name: 'Event Management', industryName: 'Hospitality', keywords: ['event management jobs', 'event planner', 'event coordinator', 'conference manager'] },
  
  // Media / Entertainment
  { name: 'Content Creation', industryName: 'Media / Entertainment', keywords: ['content writer jobs', 'journalist', 'editor', 'copywriter', 'content creator'] },
  { name: 'Film & TV Production', industryName: 'Media / Entertainment', keywords: ['film production jobs', 'TV production', 'video editor', 'camera operator', 'director'] },
  { name: 'Advertising', industryName: 'Media / Entertainment', keywords: ['advertising jobs', 'ad agency', 'creative director', 'media planner', 'account executive'] },
  { name: 'Social Media Management', industryName: 'Media / Entertainment', keywords: ['social media jobs', 'social media manager', 'community manager', 'digital content'] },
  
  // Logistics / Transportation
  { name: 'Logistics Operations', industryName: 'Logistics / Transportation', keywords: ['logistics jobs', 'transportation', 'fleet management', 'warehouse supervisor', 'shipping coordinator'] },
  { name: 'Supply Chain Management', industryName: 'Logistics / Transportation', keywords: ['supply chain jobs', 'SCM', 'logistics manager', 'supply chain analyst', 'distribution'] },
  { name: 'Transport Management', industryName: 'Logistics / Transportation', keywords: ['transport jobs', 'fleet manager', 'transport coordinator', 'dispatch manager'] },
  { name: 'Customs & Documentation', industryName: 'Logistics / Transportation', keywords: ['customs jobs', 'export import', 'documentation executive', 'freight forwarding'] },
  
  // Telecommunications
  { name: 'Network Operations', industryName: 'Telecommunications', keywords: ['network engineer jobs', 'telecom engineer', 'RF engineer', 'network operations', 'transmission engineer'] },
  { name: 'Telecom Sales', industryName: 'Telecommunications', keywords: ['telecom sales jobs', 'mobile sales', 'broadband sales', 'enterprise sales telecom'] },
  { name: 'Customer Service (Telecom)', industryName: 'Telecommunications', keywords: ['telecom customer service', 'call center telecom', 'customer care telecom', 'telecom support'] },
  { name: 'Technical Support (Telecom)', industryName: 'Telecommunications', keywords: ['telecom technical support', 'field engineer telecom', 'installation engineer', 'maintenance telecom'] },
  
  // Pharmaceuticals
  { name: 'Pharmaceutical Sales', industryName: 'Pharmaceuticals', keywords: ['pharma sales jobs', 'medical representative', 'pharma marketing', 'product manager pharma'] },
  { name: 'Production (Pharma)', industryName: 'Pharmaceuticals', keywords: ['pharma production jobs', 'manufacturing pharma', 'tablet production', 'capsule manufacturing'] },
  { name: 'Quality Control (Pharma)', industryName: 'Pharmaceuticals', keywords: ['pharma QC jobs', 'quality control pharma', 'laboratory analyst', 'QC chemist'] },
  { name: 'Research & Development (Pharma)', industryName: 'Pharmaceuticals', keywords: ['pharma R&D jobs', 'formulation scientist', 'drug development', 'clinical research pharma'] },
  
  // Textile & Garments
  { name: 'Garment Production', industryName: 'Textile & Garments', keywords: ['garment jobs', 'apparel manufacturing', 'stitching jobs', 'tailoring', 'garment factory'] },
  { name: 'Fashion Design', industryName: 'Textile & Garments', keywords: ['fashion designer jobs', 'apparel designer', 'textile designer', 'fashion stylist'] },
  { name: 'Textile Engineering', industryName: 'Textile & Garments', keywords: ['textile engineer jobs', 'fabric technologist', 'dyeing printing', 'textile chemistry'] },
  { name: 'Merchandising (Textile)', industryName: 'Textile & Garments', keywords: ['textile merchandising', 'garment merchandiser', 'export merchandiser', 'buyer textile'] },
  
  // Energy & Mining
  { name: 'Oil & Gas Operations', industryName: 'Energy & Mining', keywords: ['oil and gas jobs', 'petroleum engineer', 'rig operator', 'offshore jobs', 'drilling engineer'] },
  { name: 'Power Plant Operations', industryName: 'Energy & Mining', keywords: ['power plant jobs', 'thermal power', 'hydroelectric', 'power generation', 'plant operator'] },
  { name: 'Mining Operations', industryName: 'Energy & Mining', keywords: ['mining jobs', 'mine engineer', 'geologist', 'mining supervisor', 'quarry manager'] },
  { name: 'Renewable Energy', industryName: 'Energy & Mining', keywords: ['renewable energy jobs', 'solar energy', 'wind energy', 'green energy', 'solar technician'] },
  
  // Consulting
  { name: 'Management Consulting', industryName: 'Consulting', keywords: ['management consultant jobs', 'strategy consultant', 'business consultant', 'process consultant'] },
  { name: 'IT Consulting', industryName: 'Consulting', keywords: ['IT consultant jobs', 'technology consultant', 'systems consultant', 'ERP consultant'] },
  { name: 'Financial Consulting', industryName: 'Consulting', keywords: ['financial consultant jobs', 'tax consultant', 'audit consultant', 'financial advisor'] },
  { name: 'HR Consulting', industryName: 'Consulting', keywords: ['HR consultant jobs', 'recruitment consultant', 'training consultant', 'HR advisory'] },
  
  // Aviation & Aerospace
  { name: 'Flight Operations', industryName: 'Aviation & Aerospace', keywords: ['pilot jobs', 'flight attendant', 'air traffic controller', 'flight dispatcher', 'cabin crew'] },
  { name: 'Aircraft Maintenance', industryName: 'Aviation & Aerospace', keywords: ['aircraft maintenance jobs', 'AME engineer', 'aircraft technician', 'aviation mechanic', 'line maintenance'] },
  { name: 'Airport Operations', industryName: 'Aviation & Aerospace', keywords: ['airport jobs', 'ground staff', 'ramp agent', 'airport security', 'baggage handler'] },
  { name: 'Aerospace Engineering', industryName: 'Aviation & Aerospace', keywords: ['aerospace engineer jobs', 'avionics engineer', 'aircraft design', 'space technology', 'aeronautical engineer'] },
  
  // Beauty, Fitness & Personal Care
  { name: 'Beauty Services', industryName: 'Beauty, Fitness & Personal Care', keywords: ['beautician jobs', 'makeup artist', 'salon manager', 'spa therapist', 'hair stylist'] },
  { name: 'Fitness & Wellness', industryName: 'Beauty, Fitness & Personal Care', keywords: ['fitness trainer jobs', 'gym instructor', 'yoga teacher', 'personal trainer', 'wellness coach'] },
  { name: 'Skincare & Cosmetics', industryName: 'Beauty, Fitness & Personal Care', keywords: ['skincare jobs', 'cosmetologist', 'esthetician', 'beauty advisor', 'cosmetics sales'] },
  { name: 'Salon Management', industryName: 'Beauty, Fitness & Personal Care', keywords: ['salon manager jobs', 'beauty salon owner', 'spa manager', 'salon coordinator'] },
];

// Combine all functional areas
const functionalAreasData = [...globalFunctionalAreasData, ...industrySpecificFunctionalAreasData];

// COMMON ROLES FOR ALL INDUSTRIES (Global Roles)
const commonRoles = [
  // Seniority-based common roles (appear in all industries)
  { name: 'Manager', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Senior Manager', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Assistant Manager', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Team Lead', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Supervisor', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Executive', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Senior Executive', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Junior Executive', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Trainee', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Intern', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Associate', functionalAreaName: 'Operations', isGlobal: true },
  { name: 'Senior Associate', functionalAreaName: 'Operations', isGlobal: true },

//   business roles (global)
  { name: 'Business Analyst', functionalAreaName: 'Business Analysis', isGlobal: true },
  { name: 'Senior Business Analyst', functionalAreaName: 'Business Analysis', isGlobal: true },
  { name: 'Junior Business Analyst', functionalAreaName: 'Business Analysis', isGlobal: true },
  { name: 'Process Improvement Specialist', functionalAreaName: 'Business Analysis', isGlobal: true },
  
  // Sales roles (global)
  { name: 'Sales Manager', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  { name: 'Sales Executive', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  { name: 'Sales Representative', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  { name: 'Business Development Manager', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  { name: 'Business Development Executive', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  { name: 'Account Manager', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  { name: 'Key Account Manager', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  { name: 'Relationship Manager', functionalAreaName: 'Sales & Business Development', isGlobal: true },
  
  // Customer Service roles (global)
  { name: 'Customer Service Manager', functionalAreaName: 'Customer Support & Service', isGlobal: true },
  { name: 'Customer Service Executive', functionalAreaName: 'Customer Support & Service', isGlobal: true },
  { name: 'Customer Support Executive', functionalAreaName: 'Customer Support & Service', isGlobal: true },
  { name: 'Call Center Executive', functionalAreaName: 'Customer Support & Service', isGlobal: true },
  { name: 'Helpdesk Executive', functionalAreaName: 'Customer Support & Service', isGlobal: true },
  
  // Administrative roles (global)
  { name: 'Administrative Manager', functionalAreaName: 'Administration', isGlobal: true },
  { name: 'Administrative Executive', functionalAreaName: 'Administration', isGlobal: true },
  { name: 'Office Administrator', functionalAreaName: 'Administration', isGlobal: true },
  { name: 'Front Desk Executive', functionalAreaName: 'Administration', isGlobal: true },
  { name: 'Receptionist', functionalAreaName: 'Administration', isGlobal: true },
  { name: 'Office Assistant', functionalAreaName: 'Administration', isGlobal: true },
  { name: 'Secretary', functionalAreaName: 'Administration', isGlobal: true },
  
  // HR roles (global)
  { name: 'HR Manager', functionalAreaName: 'Human Resources', isGlobal: true },
  { name: 'HR Executive', functionalAreaName: 'Human Resources', isGlobal: true },
  { name: 'Recruitment Manager', functionalAreaName: 'Human Resources', isGlobal: true },
  { name: 'Recruitment Executive', functionalAreaName: 'Human Resources', isGlobal: true },
  { name: 'Talent Acquisition Specialist', functionalAreaName: 'Human Resources', isGlobal: true },
  { name: 'Payroll Executive', functionalAreaName: 'Human Resources', isGlobal: true },
  { name: 'Compensation & Benefits Manager', functionalAreaName: 'Human Resources', isGlobal: true },
  
  // Finance roles (global)
  { name: 'Finance Manager', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  { name: 'Accountant', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  { name: 'Senior Accountant', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  { name: 'Accounts Executive', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  { name: 'Financial Analyst', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  { name: 'Billing Executive', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  { name: 'Tax Executive', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  { name: 'Audit Executive', functionalAreaName: 'Finance & Accounting', isGlobal: true },
  
  // Marketing roles (global)
  { name: 'Marketing Manager', functionalAreaName: 'Marketing', isGlobal: true },
  { name: 'Marketing Executive', functionalAreaName: 'Marketing', isGlobal: true },
  { name: 'Digital Marketing Executive', functionalAreaName: 'Marketing', isGlobal: true },
  { name: 'Brand Manager', functionalAreaName: 'Marketing', isGlobal: true },
  { name: 'Marketing Analyst', functionalAreaName: 'Marketing', isGlobal: true },
  
  // IT Support roles (global)
  { name: 'IT Manager', functionalAreaName: 'Information Technology (IT)', isGlobal: true },
  { name: 'IT Support Executive', functionalAreaName: 'Information Technology (IT)', isGlobal: true },
  { name: 'System Administrator', functionalAreaName: 'Information Technology (IT)', isGlobal: true },
  { name: 'Technical Support Engineer', functionalAreaName: 'Information Technology (IT)', isGlobal: true },
  { name: 'Network Administrator', functionalAreaName: 'Information Technology (IT)', isGlobal: true },
  
];

// INDUSTRY-SPECIFIC ROLES
const industrySpecificRoles = [
  // IT / Software specific roles
  { name: 'Software Developer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Senior Software Engineer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Junior Software Engineer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Full Stack Developer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Frontend Developer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Backend Developer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Mobile App Developer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'DevOps Engineer', functionalAreaName: 'Cloud & DevOps', isGlobal: false },
  { name: 'Cloud Engineer', functionalAreaName: 'Cloud & DevOps', isGlobal: false },
  { name: 'Data Scientist', functionalAreaName: 'Data Science & Analytics', isGlobal: false },
  { name: 'Data Analyst', functionalAreaName: 'Data Science & Analytics', isGlobal: false },
  { name: 'QA Engineer', functionalAreaName: 'Quality Assurance', isGlobal: false },
  { name: 'Test Engineer', functionalAreaName: 'Quality Assurance', isGlobal: false },
  { name: 'Security Analyst', functionalAreaName: 'Cyber Security', isGlobal: false },
  { name: 'UI/UX Designer', functionalAreaName: 'UX/UI Design', isGlobal: false },
  { name: 'Product Manager', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Technical Lead', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Project Manager (IT)', functionalAreaName: 'Project & Program Management', isGlobal: false },
  { name: 'Scrum Master', functionalAreaName: 'Project & Program Management', isGlobal: false },
  { name: 'Database Administrator', functionalAreaName: 'IT Infrastructure', isGlobal: false },
  { name: 'Network Engineer', functionalAreaName: 'IT Infrastructure', isGlobal: false },
  { name: 'System Engineer', functionalAreaName: 'IT Infrastructure', isGlobal: false },
  { name: 'AI Engineer', functionalAreaName: 'Artificial Intelligence (AI) & Machine Learning', isGlobal: false },
  { name: 'Machine Learning Engineer', functionalAreaName: 'Artificial Intelligence (AI) & Machine Learning', isGlobal: false },
  { name: 'NLP Engineer', functionalAreaName: 'Artificial Intelligence (AI) & Machine Learning', isGlobal: false },
  { name: 'Computer Vision Engineer', functionalAreaName: 'Artificial Intelligence (AI) & Machine Learning', isGlobal: false },
  { name: 'AI Researcher', functionalAreaName: 'Artificial Intelligence (AI) & Machine Learning', isGlobal: false },
  { name: 'Software Architect', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Application Developer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Software Engineer', functionalAreaName: 'Software Development', isGlobal: false },
  { name: 'Web Developer', functionalAreaName: 'Web Development', isGlobal: false },
  { name: 'UI Developer', functionalAreaName: 'Web Development', isGlobal: false },
  { name: 'Android Developer', functionalAreaName: 'Mobile App Development', isGlobal: false },
  { name: 'iOS Developer', functionalAreaName: 'Mobile App Development', isGlobal: false },
  { name: 'Flutter Developer', functionalAreaName: 'Mobile App Development', isGlobal: false },
  { name: 'React Native Developer', functionalAreaName: 'Mobile App Development', isGlobal: false },
  { name: 'Mobile App Architect', functionalAreaName: 'Mobile App Development', isGlobal: false },
  { name: 'Cybersecurity Analyst', functionalAreaName: 'Cybersecurity', isGlobal: false },
  { name: 'Security Engineer', functionalAreaName: 'Cybersecurity', isGlobal: false },
  { name: 'Ethical Hacker', functionalAreaName: 'Cybersecurity', isGlobal: false },
  { name: 'Penetration Tester', functionalAreaName: 'Cybersecurity', isGlobal: false },
  { name: 'Security Architect', functionalAreaName: 'Cybersecurity', isGlobal: false },
  { name: 'SOC Analyst', functionalAreaName: 'Cybersecurity', isGlobal: false },
  { name: 'Cloud Architect', functionalAreaName: 'Cloud Computing', isGlobal: false },
  { name: 'Cloud Security Engineer', functionalAreaName: 'Cloud Computing', isGlobal: false },
  { name: 'Cloud Administrator', functionalAreaName: 'Cloud Computing', isGlobal: false },
  { name: 'Business Intelligence Analyst', functionalAreaName: 'Data Science & Analytics', isGlobal: false },
  { name: 'Data Engineer', functionalAreaName: 'Data Science & Analytics', isGlobal: false },
  { name: 'Analytics Consultant', functionalAreaName: 'Data Science & Analytics', isGlobal: false },
  { name: 'Database Administrator (DBA)', functionalAreaName: 'Database Management', isGlobal: false },
  { name: 'Database Developer', functionalAreaName: 'Database Management', isGlobal: false },
  { name: 'Data Architect', functionalAreaName: 'Database Management', isGlobal: false },
  { name: 'SQL Developer', functionalAreaName: 'Database Management', isGlobal: false },
  { name: 'Database Engineer', functionalAreaName: 'Database Management', isGlobal: false },
  { name: 'Automation Engineer', functionalAreaName: 'DevOps & Automation', isGlobal: false },
  { name: 'Site Reliability Engineer (SRE)', functionalAreaName: 'DevOps & Automation', isGlobal: false },
  { name: 'Infrastructure Engineer', functionalAreaName: 'DevOps & Automation', isGlobal: false },
  { name: 'CI/CD Engineer', functionalAreaName: 'DevOps & Automation', isGlobal: false },
  { name: 'Network Administrator', functionalAreaName: 'Networking & Infrastructure', isGlobal: false },
  { name: 'Systems Engineer', functionalAreaName: 'Networking & Infrastructure', isGlobal: false },
  { name: 'Infrastructure Architect', functionalAreaName: 'Networking & Infrastructure', isGlobal: false },
  { name: 'IT Support Engineer', functionalAreaName: 'Networking & Infrastructure', isGlobal: false },
  { name: 'IT Support Specialist', functionalAreaName: 'IT Support & Helpdesk', isGlobal: false },
  { name: 'Helpdesk Technician', functionalAreaName: 'IT Support & Helpdesk', isGlobal: false },
  { name: 'Desktop Support Engineer', functionalAreaName: 'IT Support & Helpdesk', isGlobal: false },
  { name: 'IT Administrator', functionalAreaName: 'IT Support & Helpdesk', isGlobal: false },
  { name: 'UI Designer', functionalAreaName: 'UI/UX Design', isGlobal: false },
  { name: 'UX Designer', functionalAreaName: 'UI/UX Design', isGlobal: false },
  { name: 'Product Designer', functionalAreaName: 'UI/UX Design', isGlobal: false },
  { name: 'Interaction Designer', functionalAreaName: 'UI/UX Design', isGlobal: false },
  { name: 'UX Researcher', functionalAreaName: 'UI/UX Design', isGlobal: false },
  { name: 'Automation Tester', functionalAreaName: 'Quality Assurance & Testing', isGlobal: false },
  { name: 'Manual Tester', functionalAreaName: 'Quality Assurance & Testing', isGlobal: false },
  { name: 'Performance Tester', functionalAreaName: 'Quality Assurance & Testing', isGlobal: false },
  { name: 'Blockchain Developer', functionalAreaName: 'Blockchain Technology', isGlobal: false },
  { name: 'Smart Contract Developer', functionalAreaName: 'Blockchain Technology', isGlobal: false },
  { name: 'Blockchain Architect', functionalAreaName: 'Blockchain Technology', isGlobal: false },
  { name: 'Crypto Analyst', functionalAreaName: 'Blockchain Technology', isGlobal: false },
  { name: 'IoT Engineer', functionalAreaName: 'Internet of Things (IoT)', isGlobal: false },
  { name: 'Embedded Systems Engineer', functionalAreaName: 'Internet of Things (IoT)', isGlobal: false },
  { name: 'Firmware Developer', functionalAreaName: 'Internet of Things (IoT)', isGlobal: false },
  { name: 'IoT Architect', functionalAreaName: 'Internet of Things (IoT)', isGlobal: false },
  { name: 'Game Developer', functionalAreaName: 'Game Development', isGlobal: false },
  { name: 'Game Designer', functionalAreaName: 'Game Development', isGlobal: false },
  { name: 'Unity Developer', functionalAreaName: 'Game Development', isGlobal: false },
  { name: 'Unreal Engine Developer', functionalAreaName: 'Game Development', isGlobal: false },
  { name: 'Game Tester', functionalAreaName: 'Game Development', isGlobal: false },
  { name: 'SAP Consultant', functionalAreaName: 'ERP & Enterprise Systems', isGlobal: false },
  { name: 'ERP Developer', functionalAreaName: 'ERP & Enterprise Systems', isGlobal: false },
  { name: 'ERP Functional Analyst', functionalAreaName: 'ERP & Enterprise Systems', isGlobal: false },
  { name: 'SAP ABAP Developer', functionalAreaName: 'ERP & Enterprise Systems', isGlobal: false },
  { name: 'SEO Analyst', functionalAreaName: 'Digital Marketing (IT Sector)', isGlobal: false },
  { name: 'SEO Specialist', functionalAreaName: 'Digital Marketing (IT Sector)', isGlobal: false },
  { name: 'PPC Specialist', functionalAreaName: 'Digital Marketing (IT Sector)', isGlobal: false },
  { name: 'Marketing Automation Specialist', functionalAreaName: 'Digital Marketing (IT Sector)', isGlobal: false },
  { name: 'Google Ads Executive', functionalAreaName: 'Digital Marketing (IT Sector)', isGlobal: false },
  { name: 'Google Ads Expert', functionalAreaName: 'Digital Marketing (IT Sector)', isGlobal: false },
  { name: 'Advertisement Specialist', functionalAreaName: 'Digital Marketing (IT Sector)', isGlobal: false },
  
  // Healthcare specific roles
  { name: 'Doctor', functionalAreaName: 'Clinical & Medical', isGlobal: false },
  { name: 'Senior Doctor', functionalAreaName: 'Clinical & Medical', isGlobal: false },
  { name: 'Medical Officer', functionalAreaName: 'Clinical & Medical', isGlobal: false },
  { name: 'Nurse', functionalAreaName: 'Clinical & Medical', isGlobal: false },
  { name: 'Staff Nurse', functionalAreaName: 'Clinical & Medical', isGlobal: false },
  { name: 'Senior Nurse', functionalAreaName: 'Clinical & Medical', isGlobal: false },
  { name: 'Pharmacist', functionalAreaName: 'Healthcare Support', isGlobal: false },
  { name: 'Senior Pharmacist', functionalAreaName: 'Healthcare Support', isGlobal: false },
  { name: 'Lab Technician', functionalAreaName: 'Healthcare Support', isGlobal: false },
  { name: 'Medical Lab Technician', functionalAreaName: 'Healthcare Support', isGlobal: false },
  { name: 'Radiology Technician', functionalAreaName: 'Healthcare Support', isGlobal: false },
  { name: 'Physiotherapist', functionalAreaName: 'Healthcare Support', isGlobal: false },
  { name: 'Medical Representative', functionalAreaName: 'Sales & Business Development', isGlobal: false },
  { name: 'Hospital Administrator', functionalAreaName: 'Hospital Administration', isGlobal: false },
  { name: 'Medical Superintendent', functionalAreaName: 'Hospital Administration', isGlobal: false },
  { name: 'Research Scientist', functionalAreaName: 'Medical Research', isGlobal: false },
  { name: 'Clinical Research Associate', functionalAreaName: 'Medical Research', isGlobal: false },
  
  // Banking specific roles
  { name: 'Bank Manager', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Branch Manager', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Assistant Branch Manager', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Relationship Manager (Banking)', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Personal Banker', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Loan Officer', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Credit Analyst', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Operations Manager (Banking)', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Teller', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Cashier (Banking)', functionalAreaName: 'Banking Operations', isGlobal: false },
  { name: 'Investment Advisor', functionalAreaName: 'Investment Banking', isGlobal: false },
  { name: 'Portfolio Manager', functionalAreaName: 'Wealth Management', isGlobal: false },
  { name: 'Financial Planner', functionalAreaName: 'Wealth Management', isGlobal: false },
  
  // Insurance specific roles
  { name: 'Insurance Agent', functionalAreaName: 'Insurance Operations', isGlobal: false },
  { name: 'Insurance Advisor', functionalAreaName: 'Insurance Operations', isGlobal: false },
  { name: 'Insurance Sales Executive', functionalAreaName: 'Insurance Operations', isGlobal: false },
  { name: 'Claims Executive', functionalAreaName: 'Insurance Operations', isGlobal: false },
  { name: 'Claims Manager', functionalAreaName: 'Insurance Operations', isGlobal: false },
  { name: 'Underwriter', functionalAreaName: 'Insurance Operations', isGlobal: false },
  { name: 'Actuary', functionalAreaName: 'Insurance Operations', isGlobal: false },
  { name: 'Insurance Surveyor', functionalAreaName: 'Insurance Operations', isGlobal: false },
  
  // Manufacturing specific roles
  { name: 'Production Manager', functionalAreaName: 'Production & Manufacturing', isGlobal: false },
  { name: 'Production Supervisor', functionalAreaName: 'Production & Manufacturing', isGlobal: false },
  { name: 'Production Engineer', functionalAreaName: 'Production & Manufacturing', isGlobal: false },
  { name: 'Shift Incharge', functionalAreaName: 'Production & Manufacturing', isGlobal: false },
  { name: 'Machine Operator', functionalAreaName: 'Production & Manufacturing', isGlobal: false },
  { name: 'CNC Operator', functionalAreaName: 'Production & Manufacturing', isGlobal: false },
  { name: 'Assembly Line Worker', functionalAreaName: 'Production & Manufacturing', isGlobal: false },
  { name: 'Quality Control Inspector', functionalAreaName: 'Quality Assurance', isGlobal: false },
  { name: 'QC Manager', functionalAreaName: 'Quality Assurance', isGlobal: false },
  { name: 'Maintenance Engineer', functionalAreaName: 'Maintenance & Repair', isGlobal: false },
  { name: 'Maintenance Technician', functionalAreaName: 'Maintenance & Repair', isGlobal: false },
  { name: 'Electrical Technician', functionalAreaName: 'Maintenance & Repair', isGlobal: false },
  { name: 'Mechanical Engineer', functionalAreaName: 'Mechanical Engineering', isGlobal: false },
  { name: 'Design Engineer', functionalAreaName: 'Mechanical Engineering', isGlobal: false },
  { name: 'Industrial Engineer', functionalAreaName: 'Industrial Engineering', isGlobal: false },
  { name: 'Plant Manager', functionalAreaName: 'Operations', isGlobal: false },
  { name: 'Factory Manager', functionalAreaName: 'Operations', isGlobal: false },
  { name: 'Automotive Engineer', functionalAreaName: 'Mechanical Engineering', keywords: ['automotive engineer jobs'] }, // ← NEW

  
  // Construction specific roles
  { name: 'Site Engineer', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Civil Engineer', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Senior Civil Engineer', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Structural Engineer', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Site Supervisor', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Site Manager', functionalAreaName: 'Project Management (Construction)', isGlobal: false },
  { name: 'Construction Manager', functionalAreaName: 'Project Management (Construction)', isGlobal: false },
  { name: 'Project Manager (Construction)', functionalAreaName: 'Project Management (Construction)', isGlobal: false },
  { name: 'Architect', functionalAreaName: 'Architecture & Interior Design', isGlobal: false },
  { name: 'Interior Designer', functionalAreaName: 'Architecture & Interior Design', isGlobal: false },
  { name: 'Quantity Surveyor', functionalAreaName: 'Quantity Surveying', isGlobal: false },
  { name: 'Safety Officer', functionalAreaName: 'Health, Safety & Environment (HSE)', isGlobal: false },
  { name: 'Safety Manager', functionalAreaName: 'Health, Safety & Environment (HSE)', isGlobal: false },
  { name: 'Mason', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Carpenter', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Welder', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Electrician (Construction)', functionalAreaName: 'Civil Engineering', isGlobal: false },
  { name: 'Plumber', functionalAreaName: 'Civil Engineering', isGlobal: false },
  
  // Retail specific roles
  { name: 'Store Manager', functionalAreaName: 'Store Operations', isGlobal: false },
  { name: 'Assistant Store Manager', functionalAreaName: 'Store Operations', isGlobal: false },
  { name: 'Store Supervisor', functionalAreaName: 'Store Operations', isGlobal: false },
  { name: 'Sales Associate', functionalAreaName: 'Store Operations', isGlobal: false },
  { name: 'Cashier', functionalAreaName: 'Store Operations', isGlobal: false },
  { name: 'Visual Merchandiser', functionalAreaName: 'Merchandising', isGlobal: false },
  { name: 'Merchandiser', functionalAreaName: 'Merchandising', isGlobal: false },
  { name: 'Buyer', functionalAreaName: 'Merchandising', isGlobal: false },
  { name: 'Category Manager', functionalAreaName: 'Merchandising', isGlobal: false },
  { name: 'eCommerce Manager', functionalAreaName: 'eCommerce Management', isGlobal: false },
  { name: 'Online Store Manager', functionalAreaName: 'eCommerce Management', isGlobal: false },
  { name: 'Warehouse Manager', functionalAreaName: 'Warehouse Operations', isGlobal: false },
  { name: 'Warehouse Supervisor', functionalAreaName: 'Warehouse Operations', isGlobal: false },
  { name: 'Storekeeper', functionalAreaName: 'Warehouse Operations', isGlobal: false },
  { name: 'Inventory Manager', functionalAreaName: 'Warehouse Operations', isGlobal: false },
  
  // Hospitality specific roles
  { name: 'Hotel Manager', functionalAreaName: 'Hotel Operations', isGlobal: false },
  { name: 'Front Office Manager', functionalAreaName: 'Hotel Operations', isGlobal: false },
  { name: 'Front Desk Executive', functionalAreaName: 'Hotel Operations', isGlobal: false },
  { name: 'Housekeeping Manager', functionalAreaName: 'Hotel Operations', isGlobal: false },
  { name: 'Housekeeping Supervisor', functionalAreaName: 'Hotel Operations', isGlobal: false },
  { name: 'Housekeeping Attendant', functionalAreaName: 'Hotel Operations', isGlobal: false },
  { name: 'Chef', functionalAreaName: 'Food & Beverage', isGlobal: false },
  { name: 'Sous Chef', functionalAreaName: 'Food & Beverage', isGlobal: false },
  { name: 'Commis Chef', functionalAreaName: 'Food & Beverage', isGlobal: false },
  { name: 'Restaurant Manager', functionalAreaName: 'Food & Beverage', isGlobal: false },
  { name: 'Waiter', functionalAreaName: 'Food & Beverage', isGlobal: false },
  { name: 'Bartender', functionalAreaName: 'Food & Beverage', isGlobal: false },
  { name: 'Travel Consultant', functionalAreaName: 'Travel & Tourism', isGlobal: false },
  { name: 'Tour Guide', functionalAreaName: 'Travel & Tourism', isGlobal: false },
  { name: 'Event Manager', functionalAreaName: 'Event Management', isGlobal: false },
  { name: 'Event Coordinator', functionalAreaName: 'Event Management', isGlobal: false },
  
  // Media & Entertainment specific roles
  { name: 'Content Writer', functionalAreaName: 'Content Creation', isGlobal: false },
  { name: 'Senior Content Writer', functionalAreaName: 'Content Creation', isGlobal: false },
  { name: 'Editor', functionalAreaName: 'Content Creation', isGlobal: false },
  { name: 'Copywriter', functionalAreaName: 'Content Creation', isGlobal: false },
  { name: 'Journalist', functionalAreaName: 'Content Creation', isGlobal: false },
  { name: 'Reporter', functionalAreaName: 'Content Creation', isGlobal: false },
  { name: 'Video Editor', functionalAreaName: 'Film & TV Production', isGlobal: false },
  { name: 'Camera Operator', functionalAreaName: 'Film & TV Production', isGlobal: false },
  { name: 'Director', functionalAreaName: 'Film & TV Production', isGlobal: false },
  { name: 'Producer', functionalAreaName: 'Film & TV Production', isGlobal: false },
  { name: 'Creative Director', functionalAreaName: 'Advertising', isGlobal: false },
  { name: 'Art Director', functionalAreaName: 'Advertising', isGlobal: false },
  { name: 'Account Executive (Advertising)', functionalAreaName: 'Advertising', isGlobal: false },
  { name: 'Media Planner', functionalAreaName: 'Advertising', isGlobal: false },
  { name: 'Social Media Manager', functionalAreaName: 'Social Media Management', isGlobal: false },
  { name: 'Social Media Executive', functionalAreaName: 'Social Media Management', isGlobal: false },
  { name: 'Community Manager', functionalAreaName: 'Social Media Management', isGlobal: false },
  
  // Logistics specific roles
  { name: 'Logistics Manager', functionalAreaName: 'Logistics Operations', isGlobal: false },
  { name: 'Logistics Coordinator', functionalAreaName: 'Logistics Operations', isGlobal: false },
  { name: 'Transport Manager', functionalAreaName: 'Transport Management', isGlobal: false },
  { name: 'Fleet Manager', functionalAreaName: 'Transport Management', isGlobal: false },
  { name: 'Driver', functionalAreaName: 'Transport Management', isGlobal: false },
  { name: 'Delivery Executive', functionalAreaName: 'Transport Management', isGlobal: false },
  { name: 'Warehouse Manager', functionalAreaName: 'Warehouse Operations', isGlobal: false },
  { name: 'Warehouse Supervisor', functionalAreaName: 'Warehouse Operations', isGlobal: false },
  { name: 'Storekeeper', functionalAreaName: 'Warehouse Operations', isGlobal: false },
  { name: 'Supply Chain Manager', functionalAreaName: 'Supply Chain Management', isGlobal: false },
  { name: 'Supply Chain Analyst', functionalAreaName: 'Supply Chain Management', isGlobal: false },
  { name: 'Procurement Manager', functionalAreaName: 'Procurement & Supply Chain', isGlobal: false },
  { name: 'Purchase Executive', functionalAreaName: 'Procurement & Supply Chain', isGlobal: false },
  { name: 'Customs Executive', functionalAreaName: 'Customs & Documentation', isGlobal: false },
  { name: 'Documentation Executive', functionalAreaName: 'Customs & Documentation', isGlobal: false },
  
  // Telecom specific roles
  { name: 'Network Engineer', functionalAreaName: 'Network Operations', isGlobal: false },
  { name: 'Senior Network Engineer', functionalAreaName: 'Network Operations', isGlobal: false },
  { name: 'RF Engineer', functionalAreaName: 'Network Operations', isGlobal: false },
  { name: 'Transmission Engineer', functionalAreaName: 'Network Operations', isGlobal: false },
  { name: 'Telecom Engineer', functionalAreaName: 'Network Operations', isGlobal: false },
  { name: 'NOC Engineer', functionalAreaName: 'Network Operations', isGlobal: false },
  { name: 'Telecom Sales Manager', functionalAreaName: 'Telecom Sales', isGlobal: false },
  { name: 'Telecom Sales Executive', functionalAreaName: 'Telecom Sales', isGlobal: false },
  { name: 'Broadband Sales Executive', functionalAreaName: 'Telecom Sales', isGlobal: false },
  { name: 'Mobile Sales Executive', functionalAreaName: 'Telecom Sales', isGlobal: false },
  { name: 'Customer Service Executive (Telecom)', functionalAreaName: 'Customer Service (Telecom)', isGlobal: false },
  { name: 'Technical Support Engineer (Telecom)', functionalAreaName: 'Technical Support (Telecom)', isGlobal: false },
  { name: 'Field Engineer (Telecom)', functionalAreaName: 'Technical Support (Telecom)', isGlobal: false },
  { name: 'Installation Engineer', functionalAreaName: 'Technical Support (Telecom)', isGlobal: false },
  
  // Pharmaceutical specific roles
  { name: 'Medical Representative', functionalAreaName: 'Pharmaceutical Sales', isGlobal: false },
  { name: 'Pharma Sales Executive', functionalAreaName: 'Pharmaceutical Sales', isGlobal: false },
  { name: 'Area Sales Manager (Pharma)', functionalAreaName: 'Pharmaceutical Sales', isGlobal: false },
  { name: 'Product Manager (Pharma)', functionalAreaName: 'Pharmaceutical Sales', isGlobal: false },
  { name: 'Production Manager (Pharma)', functionalAreaName: 'Production (Pharma)', isGlobal: false },
  { name: 'Production Supervisor (Pharma)', functionalAreaName: 'Production (Pharma)', isGlobal: false },
  { name: 'Tablet Operator', functionalAreaName: 'Production (Pharma)', isGlobal: false },
  { name: 'Capsule Operator', functionalAreaName: 'Production (Pharma)', isGlobal: false },
  { name: 'QC Manager (Pharma)', functionalAreaName: 'Quality Control (Pharma)', isGlobal: false },
  { name: 'QC Analyst', functionalAreaName: 'Quality Control (Pharma)', isGlobal: false },
  { name: 'Lab Analyst', functionalAreaName: 'Quality Control (Pharma)', isGlobal: false },
  { name: 'Research Scientist (Pharma)', functionalAreaName: 'Research & Development (Pharma)', isGlobal: false },
  { name: 'Formulation Scientist', functionalAreaName: 'Research & Development (Pharma)', isGlobal: false },
  { name: 'Clinical Research Associate', functionalAreaName: 'Research & Development (Pharma)', isGlobal: false },
  { name: 'Drug Safety Associate', functionalAreaName: 'Research & Development (Pharma)', isGlobal: false },
  
  // Textile specific roles
  { name: 'Garment Production Manager', functionalAreaName: 'Garment Production', isGlobal: false },
  { name: 'Production Supervisor (Textile)', functionalAreaName: 'Garment Production', isGlobal: false },
  { name: 'Tailor', functionalAreaName: 'Garment Production', isGlobal: false },
  { name: 'Stitching Master', functionalAreaName: 'Garment Production', isGlobal: false },
  { name: 'Cutting Master', functionalAreaName: 'Garment Production', isGlobal: false },
  { name: 'Fashion Designer', functionalAreaName: 'Fashion Design', isGlobal: false },
  { name: 'Apparel Designer', functionalAreaName: 'Fashion Design', isGlobal: false },
  { name: 'Textile Designer', functionalAreaName: 'Fashion Design', isGlobal: false },
  { name: 'Textile Engineer', functionalAreaName: 'Textile Engineering', isGlobal: false },
  { name: 'Fabric Technologist', functionalAreaName: 'Textile Engineering', isGlobal: false },
  { name: 'Dyeing Master', functionalAreaName: 'Textile Engineering', isGlobal: false },
  { name: 'Printing Supervisor', functionalAreaName: 'Textile Engineering', isGlobal: false },
  { name: 'Merchandiser (Textile)', functionalAreaName: 'Merchandising (Textile)', isGlobal: false },
  { name: 'Export Merchandiser', functionalAreaName: 'Merchandising (Textile)', isGlobal: false },
  { name: 'Buyer (Textile)', functionalAreaName: 'Merchandising (Textile)', isGlobal: false },
  
  // Energy & Mining specific roles
  { name: 'Petroleum Engineer', functionalAreaName: 'Oil & Gas Operations', isGlobal: false },
  { name: 'Drilling Engineer', functionalAreaName: 'Oil & Gas Operations', isGlobal: false },
  { name: 'Rig Operator', functionalAreaName: 'Oil & Gas Operations', isGlobal: false },
  { name: 'Offshore Engineer', functionalAreaName: 'Oil & Gas Operations', isGlobal: false },
  { name: 'Power Plant Engineer', functionalAreaName: 'Power Plant Operations', isGlobal: false },
  { name: 'Power Plant Operator', functionalAreaName: 'Power Plant Operations', isGlobal: false },
  { name: 'Electrical Engineer (Power)', functionalAreaName: 'Power Plant Operations', isGlobal: false },
  { name: 'Mining Engineer', functionalAreaName: 'Mining Operations', isGlobal: false },
  { name: 'Geologist', functionalAreaName: 'Mining Operations', isGlobal: false },
  { name: 'Mine Supervisor', functionalAreaName: 'Mining Operations', isGlobal: false },
  { name: 'Quarry Manager', functionalAreaName: 'Mining Operations', isGlobal: false },
  { name: 'Solar Technician', functionalAreaName: 'Renewable Energy', isGlobal: false },
  { name: 'Solar Engineer', functionalAreaName: 'Renewable Energy', isGlobal: false },
  { name: 'Wind Turbine Technician', functionalAreaName: 'Renewable Energy', isGlobal: false },
  { name: 'Renewable Energy Engineer', functionalAreaName: 'Renewable Energy', isGlobal: false },
  
  // Consulting specific roles
  { name: 'Management Consultant', functionalAreaName: 'Management Consulting', isGlobal: false },
  { name: 'Business Consultant', functionalAreaName: 'Management Consulting', isGlobal: false },
  { name: 'Strategy Consultant', functionalAreaName: 'Management Consulting', isGlobal: false },
  { name: 'IT Consultant', functionalAreaName: 'IT Consulting', isGlobal: false },
  { name: 'ERP Consultant', functionalAreaName: 'IT Consulting', isGlobal: false },
  { name: 'SAP Consultant', functionalAreaName: 'IT Consulting', isGlobal: false },
  { name: 'Financial Consultant', functionalAreaName: 'Financial Consulting', isGlobal: false },
  { name: 'Tax Consultant', functionalAreaName: 'Financial Consulting', isGlobal: false },
  { name: 'Audit Consultant', functionalAreaName: 'Financial Consulting', isGlobal: false },
  { name: 'HR Consultant', functionalAreaName: 'HR Consulting', isGlobal: false },
  { name: 'Recruitment Consultant', functionalAreaName: 'HR Consulting', isGlobal: false },
  { name: 'Training Consultant', functionalAreaName: 'HR Consulting', isGlobal: false },
  
  // Aviation & Aerospace specific roles
  { name: 'Pilot', functionalAreaName: 'Flight Operations', isGlobal: false },
  { name: 'Commercial Pilot', functionalAreaName: 'Flight Operations', isGlobal: false },
  { name: 'Flight Attendant', functionalAreaName: 'Flight Operations', isGlobal: false },
  { name: 'Cabin Crew', functionalAreaName: 'Flight Operations', isGlobal: false },
  { name: 'Air Traffic Controller', functionalAreaName: 'Flight Operations', isGlobal: false },
  { name: 'Flight Dispatcher', functionalAreaName: 'Flight Operations', isGlobal: false },
  { name: 'Aircraft Maintenance Engineer', functionalAreaName: 'Aircraft Maintenance', isGlobal: false },
  { name: 'Aircraft Technician', functionalAreaName: 'Aircraft Maintenance', isGlobal: false },
  { name: 'Aviation Mechanic', functionalAreaName: 'Aircraft Maintenance', isGlobal: false },
  { name: 'Ground Staff', functionalAreaName: 'Airport Operations', isGlobal: false },
  { name: 'Ramp Agent', functionalAreaName: 'Airport Operations', isGlobal: false },
  { name: 'Airport Security', functionalAreaName: 'Airport Operations', isGlobal: false },
  { name: 'Baggage Handler', functionalAreaName: 'Airport Operations', isGlobal: false },
  { name: 'Aerospace Engineer', functionalAreaName: 'Aerospace Engineering', isGlobal: false },
  { name: 'Avionics Engineer', functionalAreaName: 'Aerospace Engineering', isGlobal: false },
  { name: 'Aircraft Design Engineer', functionalAreaName: 'Aerospace Engineering', isGlobal: false },
  
  // Beauty, Fitness & Personal Care specific roles
  { name: 'Beautician', functionalAreaName: 'Beauty Services', isGlobal: false },
  { name: 'Senior Beautician', functionalAreaName: 'Beauty Services', isGlobal: false },
  { name: 'Makeup Artist', functionalAreaName: 'Beauty Services', isGlobal: false },
  { name: 'Hair Stylist', functionalAreaName: 'Beauty Services', isGlobal: false },
  { name: 'Salon Manager', functionalAreaName: 'Salon Management', isGlobal: false },
  { name: 'Spa Therapist', functionalAreaName: 'Beauty Services', isGlobal: false },
  { name: 'Spa Manager', functionalAreaName: 'Salon Management', isGlobal: false },
  { name: 'Fitness Trainer', functionalAreaName: 'Fitness & Wellness', isGlobal: false },
  { name: 'Personal Trainer', functionalAreaName: 'Fitness & Wellness', isGlobal: false },
  { name: 'Gym Instructor', functionalAreaName: 'Fitness & Wellness', isGlobal: false },
  { name: 'Yoga Teacher', functionalAreaName: 'Fitness & Wellness', isGlobal: false },
  { name: 'Wellness Coach', functionalAreaName: 'Fitness & Wellness', isGlobal: false },
  { name: 'Cosmetologist', functionalAreaName: 'Skincare & Cosmetics', isGlobal: false },
  { name: 'Esthetician', functionalAreaName: 'Skincare & Cosmetics', isGlobal: false },
  { name: 'Beauty Advisor', functionalAreaName: 'Skincare & Cosmetics', isGlobal: false },
  { name: 'Cosmetics Sales Executive', functionalAreaName: 'Skincare & Cosmetics', isGlobal: false },

   // Education & Training (A-Z)
  { name: 'Academic Counselor', functionalAreaName: 'Education & Training', isGlobal: false }, // NEW
  { name: 'Content Developer', functionalAreaName: 'Education & Training', isGlobal: false },
  { name: 'Faculty', functionalAreaName: 'Education & Training', isGlobal: true },
  { name: 'Lecturer', functionalAreaName: 'Education & Training',  isGlobal: false },
  { name: 'Teacher', functionalAreaName: 'Education & Training', isGlobal: true },
  { name: 'Trainer', functionalAreaName: 'Education & Training', isGlobal: true },
];

// Combine all roles
const rolesData = [...commonRoles, ...industrySpecificRoles];

// Add keywords to all roles
rolesData.forEach(role => {
  const baseKeywords = role.name.toLowerCase().split(' ').map(word => `${word} jobs`);
  const industryKeyword = role.isGlobal ? 'all industries' : '';
  role.keywords = [...baseKeywords, `${role.name} vacancies`, `${role.name} careers`, `${role.name} openings`, industryKeyword].filter(Boolean);
});

// Enhanced locations data (keep your existing locations)
const locationsData = [
  { name: 'Coimbatore', state: 'Tamil Nadu', keywords: ['jobs in coimbatore'] },
  { name: 'Avarampalayam', state: 'Tamil Nadu', keywords: ['jobs in avarampalayam'] },
  { name: 'Avarampalayam Road', state: 'Tamil Nadu', keywords: ['jobs in avarampalayam road'] },
  { name: 'Avinashi Road', state: 'Tamil Nadu', keywords: ['jobs in avinashi road'] },
  { name: 'Annur', state: 'Tamil Nadu', keywords: ['jobs in annur'] },
  { name: 'Anaimalai', state: 'Tamil Nadu', keywords: ['jobs in anaimalai'] },
  { name: 'Bharathi Colony', state: 'Tamil Nadu', keywords: ['jobs in bharathi colony'] },
  { name: 'Bharathiyar Road', state: 'Tamil Nadu', keywords: ['jobs in bharathiyar road'] },
  { name: 'BRS Nagar', state: 'Tamil Nadu', keywords: ['jobs in brs nagar'] },
  { name: 'B.K. Pudur', state: 'Tamil Nadu', keywords: ['jobs in b k pudur'] },
  { name: 'Cheran Nagar', state: 'Tamil Nadu', keywords: ['jobs in cheran nagar'] },
  { name: 'Chettipalayam', state: 'Tamil Nadu', keywords: ['jobs in chettipalayam'] },
  { name: 'Chinniyampalayam', state: 'Tamil Nadu', keywords: ['jobs in chinniyampalayam'] },
  { name: 'Chinnavedampatti', state: 'Tamil Nadu', keywords: ['jobs in chinnavedampatti'] },
  { name: 'Civil Aerodrome', state: 'Tamil Nadu', keywords: ['jobs in civil aerodrome'] },
  { name: 'Dharapuram Road', state: 'Tamil Nadu', keywords: ['jobs in dharapuram road'] },
  { name: 'Dr. Nanjappa Road', state: 'Tamil Nadu', keywords: ['jobs in dr nanjappa road'] },
  { name: 'Eachanari', state: 'Tamil Nadu', keywords: ['jobs in eachanari'] },
  { name: 'Ganapathy', state: 'Tamil Nadu', keywords: ['jobs in ganapathy'] },
  { name: 'Gandhipuram', state: 'Tamil Nadu', keywords: ['jobs in gandhipuram'] },
  { name: 'Goundampalayam', state: 'Tamil Nadu', keywords: ['jobs in goundampalayam'] },
  { name: 'GV Residency', state: 'Tamil Nadu', keywords: ['jobs in gv residency'] },
  { name: 'Hope College', state: 'Tamil Nadu', keywords: ['jobs in hope college'] },
  { name: 'Huzur Road', state: 'Tamil Nadu', keywords: ['jobs in huzur road'] },
  { name: 'Kalapatti', state: 'Tamil Nadu', keywords: ['jobs in kalapatti'] },
  { name: 'Kanuvai', state: 'Tamil Nadu', keywords: ['jobs in kanuvai'] },
  { name: 'Karamadai', state: 'Tamil Nadu', keywords: ['jobs in karamadai'] },
  { name: 'Karumathampatti', state: 'Tamil Nadu', keywords: ['jobs in karumathampatti'] },
  { name: 'Kavundampalayam', state: 'Tamil Nadu', keywords: ['jobs in kavundampalayam'] },
  { name: 'Kinathukadavu', state: 'Tamil Nadu', keywords: ['jobs in kinathukadavu'] },
  { name: 'KNG Pudur', state: 'Tamil Nadu', keywords: ['jobs in kng pudur'] },
  { name: 'Kovaipudur', state: 'Tamil Nadu', keywords: ['jobs in kovaipudur'] },
  { name: 'Kovilpalayam', state: 'Tamil Nadu', keywords: ['jobs in kovilpalayam'] },
  { name: 'Kuniyamuthur', state: 'Tamil Nadu', keywords: ['jobs in kuniyamuthur'] },
  { name: 'Madukkarai', state: 'Tamil Nadu', keywords: ['jobs in madukkarai'] },
  { name: 'Malumichampatti', state: 'Tamil Nadu', keywords: ['jobs in malumichampatti'] },
  { name: 'Mettupalayam Road', state: 'Tamil Nadu', keywords: ['jobs in mettupalayam road'] },
  { name: 'Mettupalayam', state: 'Tamil Nadu', keywords: ['jobs in mettupalayam'] },
  { name: 'Masakalipalayam', state: 'Tamil Nadu', keywords: ['jobs in masakalipalayam'] },
  { name: 'Nallampalayam', state: 'Tamil Nadu', keywords: ['jobs in nallampalayam'] },
  { name: 'Nanjundapuram', state: 'Tamil Nadu', keywords: ['jobs in nanjundapuram'] },
  { name: 'Narasimhanaickenpalayam', state: 'Tamil Nadu', keywords: ['jobs in narasimhanaickenpalayam'] },
  { name: 'Neelambur', state: 'Tamil Nadu', keywords: ['jobs in neelambur'] },
  { name: 'Ondipudur', state: 'Tamil Nadu', keywords: ['jobs in ondipudur'] },
  { name: 'Peelamedu', state: 'Tamil Nadu', keywords: ['jobs in peelamedu'] },
  { name: 'Periyanaickenpalayam', state: 'Tamil Nadu', keywords: ['jobs in periyanaickenpalayam'] },
  { name: 'Perur', state: 'Tamil Nadu', keywords: ['jobs in perur'] },
  { name: 'Podanur', state: 'Tamil Nadu', keywords: ['jobs in podanur'] },
  { name: 'Pollachi Road', state: 'Tamil Nadu', keywords: ['jobs in pollachi road'] },
  { name: 'Puliakulam', state: 'Tamil Nadu', keywords: ['jobs in puliakulam'] },
  { name: 'Race Course', state: 'Tamil Nadu', keywords: ['jobs in race course'] },
  { name: 'Ramanathapuram', state: 'Tamil Nadu', keywords: ['jobs in ramanathapuram'] },
  { name: 'RS Puram', state: 'Tamil Nadu', keywords: ['jobs in rs puram'] },
  { name: 'Saibaba Colony', state: 'Tamil Nadu', keywords: ['jobs in saibaba colony'] },
  { name: 'Saravanampatti', state: 'Tamil Nadu', keywords: ['jobs in saravanampatti'] },
  { name: 'Selvapuram', state: 'Tamil Nadu', keywords: ['jobs in selvapuram'] },
  { name: 'Singanallur', state: 'Tamil Nadu', keywords: ['jobs in singanallur'] },
  { name: 'Sidhapudur', state: 'Tamil Nadu', keywords: ['jobs in sidhapudur'] },
  { name: 'Sulur', state: 'Tamil Nadu', keywords: ['jobs in sulur'] },
  { name: 'Sundarapuram', state: 'Tamil Nadu', keywords: ['jobs in sundarapuram'] },
  { name: 'Tatabad', state: 'Tamil Nadu', keywords: ['jobs in tatabad'] },
  { name: 'Thadagam Road', state: 'Tamil Nadu', keywords: ['jobs in thadagam road'] },
  { name: 'Thudiyalur', state: 'Tamil Nadu', keywords: ['jobs in thudiyalur'] },
  { name: 'Town Hall', state: 'Tamil Nadu', keywords: ['jobs in town hall'] },
  { name: 'Trichy Road', state: 'Tamil Nadu', keywords: ['jobs in trichy road'] },
  { name: 'Ukkadam', state: 'Tamil Nadu', keywords: ['jobs in ukkadam'] },
  { name: 'Uppilipalayam', state: 'Tamil Nadu', keywords: ['jobs in uppilipalayam'] },
  { name: 'Vadavalli', state: 'Tamil Nadu', keywords: ['jobs in vadavalli'] },
  { name: 'Varadarajapuram', state: 'Tamil Nadu', keywords: ['jobs in varadarajapuram'] },
  { name: 'Veerapandi', state: 'Tamil Nadu', keywords: ['jobs in veerapandi'] },
  { name: 'Vellalore', state: 'Tamil Nadu', keywords: ['jobs in vellalore'] },
  { name: 'Vilankurichi', state: 'Tamil Nadu', keywords: ['jobs in vilankurichi'] },
  { name: 'Vellakinar', state: 'Tamil Nadu', keywords: ['jobs in vellakinar'] },
  { name: 'Salem', state: 'Tamil Nadu', keywords: ['jobs in salem'] },
  { name: 'Erode', state: 'Tamil Nadu', keywords: ['jobs in erode'] },
  { name: 'Tiruppur', state: 'Tamil Nadu', keywords: ['jobs in tiruppur'] },
  { name: 'Chennai', state: 'Tamil Nadu', keywords: ['jobs in chennai'] },
  { name: 'Madurai', state: 'Tamil Nadu', keywords: ['jobs in madurai'] },
  { name: 'Tiruchirappalli', state: 'Tamil Nadu', keywords: ['jobs in trichy'] },
  { name: 'Hosur', state: 'Tamil Nadu', keywords: ['jobs in hosur'] },
  { name: 'Krishnagiri', state: 'Tamil Nadu', keywords: ['jobs in krishnagiri'] },
  { name: 'Dindigul', state: 'Tamil Nadu', keywords: ['jobs in dindigul'] },
  { name: 'Thoothukudi', state: 'Tamil Nadu', keywords: ['jobs in tuticorin'] },
  { name: 'Cuddalore', state: 'Tamil Nadu', keywords: ['jobs in cuddalore'] },
  { name: 'Kanchipuram', state: 'Tamil Nadu', keywords: ['jobs in kanchipuram'] },
  { name: 'Ranipet', state: 'Tamil Nadu', keywords: ['jobs in ranipet'] },
  { name: 'Vellore', state: 'Tamil Nadu', keywords: ['jobs in vellore'] },
  { name: 'Tirunelveli', state: 'Tamil Nadu', keywords: ['jobs in tirunelveli'] },
  { name: 'Nagercoil', state: 'Tamil Nadu', keywords: ['jobs in nagercoil'] },
  { name: 'Bengaluru', state: 'Karnataka', keywords: ['jobs in bengaluru', 'jobs in bangalore'] },
  { name: 'Mumbai', state: 'Maharashtra', keywords: ['jobs in mumbai'] },
  { name: 'Delhi', state: 'Delhi', keywords: ['jobs in delhi', 'jobs in new delhi'] },
  { name: 'Hyderabad', state: 'Telangana', keywords: ['jobs in hyderabad'] },
  { name: 'Pune', state: 'Maharashtra', keywords: ['jobs in pune'] },
  { name: 'Kolkata', state: 'West Bengal', keywords: ['jobs in kolkata'] },
  { name: 'Ahmedabad', state: 'Gujarat', keywords: ['jobs in ahmedabad'] },
  { name: 'Jaipur', state: 'Rajasthan', keywords: ['jobs in jaipur'] },
  { name: 'Lucknow', state: 'Uttar Pradesh', keywords: ['jobs in lucknow'] },
  { name: 'Chandigarh', state: 'Chandigarh', keywords: ['jobs in chandigarh'] },
  { name: 'Indore', state: 'Madhya Pradesh', keywords: ['jobs in indore'] },
  { name: 'Bhopal', state: 'Madhya Pradesh', keywords: ['jobs in bhopal'] },
  { name: 'Visakhapatnam', state: 'Andhra Pradesh', keywords: ['jobs in vizag'] },
  { name: 'Surat', state: 'Gujarat', keywords: ['jobs in surat'] },
  { name: 'Nagpur', state: 'Maharashtra', keywords: ['jobs in nagpur'] },
  { name: 'Kanpur', state: 'Uttar Pradesh', keywords: ['jobs in kanpur'] },
  { name: 'Patna', state: 'Bihar', keywords: ['jobs in patna'] },
  { name: 'Vadodara', state: 'Gujarat', keywords: ['jobs in vadodara'] },
  { name: 'Ludhiana', state: 'Punjab', keywords: ['jobs in ludhiana'] },
  { name: 'Agra', state: 'Uttar Pradesh', keywords: ['jobs in agra'] },
  { name: 'Nashik', state: 'Maharashtra', keywords: ['jobs in nashik'] },
  { name: 'Meerut', state: 'Uttar Pradesh', keywords: ['jobs in meerut'] },
  { name: 'Rajkot', state: 'Gujarat', keywords: ['jobs in rajkot'] },
  { name: 'Varanasi', state: 'Uttar Pradesh', keywords: ['jobs in varanasi'] },
  { name: 'Amritsar', state: 'Punjab', keywords: ['jobs in amritsar'] },
  { name: 'Allahabad', state: 'Uttar Pradesh', keywords: ['jobs in prayagraj'] },
  { name: 'Jodhpur', state: 'Rajasthan', keywords: ['jobs in jodhpur'] },
  { name: 'Vijayawada', state: 'Andhra Pradesh', keywords: ['jobs in vijayawada'] },
  { name: 'Kochi', state: 'Kerala', keywords: ['jobs in kochi'] },
  { name: 'Thiruvananthapuram', state: 'Kerala', keywords: ['jobs in trivandrum'] },
  { name: 'Guwahati', state: 'Assam', keywords: ['jobs in guwahati'] },
  { name: 'Gurugram', state: 'Haryana', keywords: ['jobs in gurugram'] }, 
  { name: 'Noida', state: 'Uttar Pradesh', keywords: ['jobs in noida'] }, 
  { name: 'Mysuru', state: 'Karnataka', keywords: ['jobs in mysore'] }, 
  { name: 'Coonoor', state: 'Tamil Nadu', keywords: ['jobs in coonoor'] },
  { name: 'Remote', state: 'Remote', keywords: ['remote jobs', 'work from home'] },
  { name: 'Work From Home', state: 'Remote', keywords: ['work from home jobs', 'wfh'] },
  { name: 'Other', state: 'All India', keywords: ['jobs in other locations', 'all india jobs'] },
];

// Enhanced skills data with programming languages
const skillsData = [
  // Programming Languages (Expanded)
  { name: 'Java', keywords: ['java developer jobs', 'java programming jobs'] },
  { name: 'Python', keywords: ['python developer jobs', 'python programming'] },
  { name: 'JavaScript', keywords: ['javascript jobs', 'js developer'] },
  { name: 'C++', keywords: ['c++ jobs', 'c++ developer'] },
  { name: 'C#', keywords: ['c# jobs', 'c# developer', 'cpp programming careers'] },
  { name: 'PHP', keywords: ['php jobs', 'php developer', 'laravel vacancies'] },
  { name: 'Ruby', keywords: ['ruby jobs', 'ruby developer', 'ruby developer vacancies'] },
  { name: 'Swift', keywords: ['swift jobs', 'ios developer'] },
  { name: 'Kotlin', keywords: ['kotlin jobs', 'android developer'] },
  { name: 'Go', keywords: ['golang jobs', 'go developer', 'go developer vacancies'] },
  { name: 'Rust', keywords: ['rust jobs', 'rust developer'] },
  { name: 'TypeScript', keywords: ['typescript jobs', 'typescript developer'] },
  { name: 'Perl', keywords: ['perl jobs', 'perl developer', 'scripting perl openings'] },
  { name: 'Scala', keywords: ['scala jobs', 'scala developer'] },
  { name: 'R', keywords: ['r programming jobs', 'data science r'] },

  // Emerging Skills (2026)
  { name: 'Prompt Engineering', keywords: ['prompt engineer jobs', 'ai prompt vacancies'] }, 
  { name: 'Blockchain', keywords: ['blockchain developer jobs', 'crypto smart contracts'] }, 
  { name: 'Sustainability', keywords: ['sustainability specialist jobs', 'green jobs'] }, 
  
  // Frontend Technologies
  { name: 'React', keywords: ['react jobs', 'react developer'] },
  { name: 'Angular', keywords: ['angular jobs', 'angular developer'] },
  { name: 'Vue.js', keywords: ['vue jobs', 'vue developer'] },
  { name: 'Next.js', keywords: ['nextjs jobs', 'next.js developer'] },
  { name: 'jQuery', keywords: ['jquery jobs', 'jquery developer'] },
  { name: 'HTML5', keywords: ['html5 jobs', 'web developer'] },
  { name: 'CSS3', keywords: ['css3 jobs', 'web designer'] },
  { name: 'SASS/SCSS', keywords: ['sass jobs', 'css preprocessor'] },
  { name: 'Bootstrap', keywords: ['bootstrap jobs', 'responsive design'] },
  { name: 'Tailwind CSS', keywords: ['tailwind jobs', 'tailwind css'] },
  
  // Backend Technologies
  { name: 'Node.js', keywords: ['nodejs jobs', 'node.js developer'] },
  { name: 'Express.js', keywords: ['expressjs jobs', 'express.js developer'] },
  { name: 'Django', keywords: ['django jobs', 'python django'] },
  { name: 'Flask', keywords: ['flask jobs', 'python flask'] },
  { name: 'Spring Boot', keywords: ['spring boot jobs', 'java spring'] },
  { name: 'Laravel', keywords: ['laravel jobs', 'php laravel'] },
  { name: 'Ruby on Rails', keywords: ['rails jobs', 'ruby on rails'] },
  { name: '.NET', keywords: ['.net jobs', 'dotnet developer'] },
  { name: 'ASP.NET', keywords: ['asp.net jobs', 'asp.net developer'] },
  { name: 'FastAPI', keywords: ['fastapi jobs', 'python api'] },
  
  // Databases
  { name: 'MySQL', keywords: ['mysql jobs', 'mysql developer'] },
  { name: 'PostgreSQL', keywords: ['postgresql jobs', 'postgres developer'] },
  { name: 'MongoDB', keywords: ['mongodb jobs', 'nosql developer'] },
  { name: 'Oracle', keywords: ['oracle jobs', 'oracle database'] },
  { name: 'SQL Server', keywords: ['sql server jobs', 'mssql developer'] },
  { name: 'Redis', keywords: ['redis jobs', 'redis cache'] },
  { name: 'Elasticsearch', keywords: ['elasticsearch jobs', 'search engine'] },
  { name: 'Cassandra', keywords: ['cassandra jobs', 'nosql database'] },
  { name: 'SQLite', keywords: ['sqlite jobs', 'embedded database'] },
  { name: 'Firebase', keywords: ['firebase jobs', 'firebase database'] },
  
  // Cloud & DevOps
  { name: 'AWS', keywords: ['aws jobs', 'amazon web services'] },
  { name: 'Azure', keywords: ['azure jobs', 'microsoft azure'] },
  { name: 'Google Cloud', keywords: ['gcp jobs', 'google cloud'] },
  { name: 'Docker', keywords: ['docker jobs', 'containerization'] },
  { name: 'Kubernetes', keywords: ['kubernetes jobs', 'container orchestration'] },
  { name: 'Terraform', keywords: ['terraform jobs', 'infrastructure as code'] },
  { name: 'Jenkins', keywords: ['jenkins jobs', 'ci/cd pipeline'] },
  { name: 'Git', keywords: ['git jobs', 'version control'] },
  { name: 'GitLab', keywords: ['gitlab jobs', 'devops platform'] },
  { name: 'GitHub', keywords: ['github jobs', 'code repository'] },
  { name: 'CI/CD', keywords: ['ci cd jobs', 'continuous integration'] },
  { name: 'Ansible', keywords: ['ansible jobs', 'configuration management'] },
  { name: 'Chef', keywords: ['chef jobs', 'infrastructure automation'] },
  { name: 'Puppet', keywords: ['puppet jobs', 'configuration management'] },
  
  // Data Science & AI
  { name: 'Machine Learning', keywords: ['machine learning jobs', 'ml engineer'] },
  { name: 'Deep Learning', keywords: ['deep learning jobs', 'neural networks'] },
  { name: 'TensorFlow', keywords: ['tensorflow jobs', 'ml framework'] },
  { name: 'PyTorch', keywords: ['pytorch jobs', 'ml library'] },
  { name: 'Keras', keywords: ['keras jobs', 'deep learning api'] },
  { name: 'Data Analytics', keywords: ['data analytics jobs', 'data analyst'] },
  { name: 'Data Visualization', keywords: ['data visualization jobs', 'visualization'] },
  { name: 'Tableau', keywords: ['tableau jobs', 'data visualization'] },
  { name: 'Power BI', keywords: ['power bi jobs', 'business intelligence'] },
  { name: 'Apache Spark', keywords: ['spark jobs', 'big data processing'] },
  { name: 'Hadoop', keywords: ['hadoop jobs', 'big data framework'] },
  { name: 'Hive', keywords: ['hive jobs', 'data warehouse'] },
  { name: 'Pandas', keywords: ['pandas jobs', 'data analysis python'] },
  { name: 'NumPy', keywords: ['numpy jobs', 'numerical python'] },
  { name: 'SciPy', keywords: ['scipy jobs', 'scientific python'] },
  
  // Mobile Development
  { name: 'Android Development', keywords: ['android developer jobs', 'android sdk'] },
  { name: 'iOS Development', keywords: ['ios developer jobs', 'ios sdk'] },
  { name: 'React Native', keywords: ['react native jobs', 'cross platform mobile'] },
  { name: 'Flutter', keywords: ['flutter jobs', 'dart framework'] },
  { name: 'Xamarin', keywords: ['xamarin jobs', 'cross platform'] },
  { name: 'SwiftUI', keywords: ['swiftui jobs', 'ios ui framework'] },
  { name: 'Kotlin Multiplatform', keywords: ['kotlin multiplatform jobs', 'cross platform'] },
  
  // Testing
  { name: 'Selenium', keywords: ['selenium jobs', 'automation testing'] },
  { name: 'JUnit', keywords: ['junit jobs', 'java testing'] },
  { name: 'TestNG', keywords: ['testng jobs', 'testing framework'] },
  { name: 'Cypress', keywords: ['cypress jobs', 'end to end testing'] },
  { name: 'Jest', keywords: ['jest jobs', 'javascript testing'] },
  { name: 'Mocha', keywords: ['mocha jobs', 'javascript testing'] },
  { name: 'JMeter', keywords: ['jmeter jobs', 'performance testing'] },
  { name: 'Load Testing', keywords: ['load testing jobs', 'performance testing'] },
  { name: 'API Testing', keywords: ['api testing jobs', 'rest api testing'] },
  { name: 'Manual Testing', keywords: ['manual testing jobs', 'software testing'] },
  { name: 'Automation Testing', keywords: ['automation testing jobs', 'test automation'] },
  
  // Business & Soft Skills
  { name: 'Project Management', keywords: ['project management jobs', 'pmp'] },
  { name: 'Agile Methodology', keywords: ['agile jobs', 'scrum'] },
  { name: 'Scrum', keywords: ['scrum jobs', 'agile framework'] },
  { name: 'Kanban', keywords: ['kanban jobs', 'lean methodology'] },
  { name: 'JIRA', keywords: ['jira jobs', 'project tracking'] },
  { name: 'Confluence', keywords: ['confluence jobs', 'documentation'] },
  { name: 'Communication Skills', keywords: ['communication skills jobs'] },
  { name: 'Leadership', keywords: ['leadership jobs', 'team management'] },
  { name: 'Problem Solving', keywords: ['problem solving jobs', 'analytical skills'] },
  { name: 'Team Management', keywords: ['team management jobs', 'team lead'] },
  { name: 'Time Management', keywords: ['time management jobs', 'organizational skills'] },
  { name: 'Critical Thinking', keywords: ['critical thinking jobs', 'analytical thinking'] },
  { name: 'Negotiation Skills', keywords: ['negotiation skills jobs', 'sales negotiation'] },
  { name: 'Customer Service', keywords: ['customer service skills', 'customer support'] },
  
  // Finance & Accounting Skills
  { name: 'Tally', keywords: ['tally jobs', 'accounting software'] },
  { name: 'QuickBooks', keywords: ['quickbooks jobs', 'accounting software'] },
  { name: 'SAP FICO', keywords: ['sap fico jobs', 'finance module'] },
  { name: 'GST', keywords: ['gst jobs', 'goods and services tax'] },
  { name: 'Income Tax', keywords: ['income tax jobs', 'taxation'] },
  { name: 'Auditing', keywords: ['auditing jobs', 'internal audit'] },
  { name: 'Financial Analysis', keywords: ['financial analysis jobs', 'financial modeling'] },
  { name: 'Risk Management', keywords: ['risk management jobs', 'financial risk'] },
  { name: 'Banking Operations', keywords: ['banking operations jobs', 'bank processes'] },
  { name: 'Insurance Knowledge', keywords: ['insurance jobs', 'insurance products'] },
  
  // Engineering & Technical Skills
  { name: 'AutoCAD', keywords: ['autocad jobs', 'cad design'] },
  { name: 'SolidWorks', keywords: ['solidworks jobs', '3d modeling'] },
  { name: 'CATIA', keywords: ['catia jobs', 'cad software'] },
  { name: 'MATLAB', keywords: ['matlab jobs', 'technical computing'] },
  { name: 'PLC Programming', keywords: ['plc jobs', 'automation'] },
  { name: 'SCADA', keywords: ['scada jobs', 'supervisory control'] },
  { name: 'CNC Programming', keywords: ['cnc jobs', 'computer numerical control'] },
  { name: 'Welding', keywords: ['welding jobs', 'fabrication'] },
  { name: 'HVAC', keywords: ['hvac jobs', 'heating ventilation'] },
  { name: 'Electrical Engineering', keywords: ['electrical engineer jobs', 'electrical design'] },
  { name: 'Mechanical Engineering', keywords: ['mechanical engineer jobs', 'mechanical design'] },
  { name: 'Civil Engineering', keywords: ['civil engineer jobs', 'construction'] },
  { name: 'Chemical Engineering', keywords: ['chemical engineer jobs', 'process engineering'] },
  
  // Medical & Healthcare Skills
  { name: 'Patient Care', keywords: ['patient care jobs', 'nursing care'] },
  { name: 'Medical Coding', keywords: ['medical coding jobs', 'icd coding'] },
  { name: 'Hospital Administration', keywords: ['hospital administration jobs', 'hospital management'] },
  { name: 'Clinical Research', keywords: ['clinical research jobs', 'clinical trials'] },
  { name: 'Pharmaceutical Knowledge', keywords: ['pharma jobs', 'drug knowledge'] },
  { name: 'Medical Equipment Operation', keywords: ['medical equipment jobs', 'equipment handling'] },
  { name: 'Laboratory Skills', keywords: ['lab technician jobs', 'lab procedures'] },
  { name: 'Radiology Skills', keywords: ['radiology jobs', 'imaging techniques'] },
  { name: 'Surgical Skills', keywords: ['surgical jobs', 'surgery assistance'] },
  { name: 'Emergency Care', keywords: ['emergency care jobs', 'emergency response'] },
  
  // Language Skills
  { name: 'English', keywords: ['english speaking jobs', 'english communication'] },
  { name: 'IELTS', keywords: ['ielts speaking jobs', 'ielts communication'] },
  { name: 'Hindi', keywords: ['hindi speaking jobs', 'hindi communication'] },
  { name: 'Tamil', keywords: ['tamil speaking jobs', 'tamil communication'] },
  { name: 'Telugu', keywords: ['telugu speaking jobs', 'telugu communication'] },
  { name: 'Kannada', keywords: ['kannada speaking jobs', 'kannada communication'] },
  { name: 'Malayalam', keywords: ['malayalam speaking jobs', 'malayalam communication'] },
  { name: 'Marathi', keywords: ['marathi speaking jobs', 'marathi communication'] },
  { name: 'Gujarati', keywords: ['gujarati speaking jobs', 'gujarati communication'] },
  { name: 'Bengali', keywords: ['bengali speaking jobs', 'bengali communication'] },
  { name: 'Punjabi', keywords: ['punjabi speaking jobs', 'punjabi communication'] },
  { name: 'French', keywords: ['french speaking jobs', 'french language'] },
  { name: 'German', keywords: ['german speaking jobs', 'german language'] },
  { name: 'Spanish', keywords: ['spanish speaking jobs', 'spanish language'] },
  { name: 'Japanese', keywords: ['japanese speaking jobs', 'japanese language'] },
  { name: 'Chinese', keywords: ['chinese speaking jobs', 'mandarin language'] },
  
  // Industry-Specific Software
  { name: 'Salesforce', keywords: ['salesforce jobs', 'crm software'] },
  { name: 'HubSpot', keywords: ['hubspot jobs', 'marketing automation'] },
  { name: 'Zoho CRM', keywords: ['zoho jobs', 'crm software'] },
  { name: 'Adobe Creative Suite', keywords: ['adobe jobs', 'creative software'] },
  { name: 'Figma', keywords: ['figma jobs', 'ui design'] },
  { name: 'Sketch', keywords: ['sketch jobs', 'ui design'] },
  { name: 'Photoshop', keywords: ['photoshop jobs', 'image editing'] },
  { name: 'Illustrator', keywords: ['illustrator jobs', 'vector graphics'] },
  { name: 'Premiere Pro', keywords: ['premiere pro jobs', 'video editing'] },
  { name: 'Final Cut Pro', keywords: ['final cut pro jobs', 'video editing'] },
  { name: 'Google Analytics', keywords: ['google analytics jobs', 'web analytics'] },
  { name: 'Google Ads', keywords: ['google ads jobs', 'ppc advertising'] },
  { name: 'Facebook Ads', keywords: ['facebook ads jobs', 'social media advertising'] },
  { name: 'SEO Tools', keywords: ['seo jobs', 'search engine optimization'] },
  { name: 'SEM', keywords: ['sem jobs', 'search engine marketing'] },
  
  // Manufacturing & Operations
  { name: 'Lean Manufacturing', keywords: ['lean manufacturing jobs', 'continuous improvement'] },
  { name: 'Six Sigma', keywords: ['six sigma jobs', 'quality management'] },
  { name: 'Kaizen', keywords: ['kaizen jobs', 'process improvement'] },
  { name: '5S Methodology', keywords: ['5s jobs', 'workplace organization'] },
  { name: 'Inventory Management', keywords: ['inventory management jobs', 'stock control'] },
  { name: 'Supply Chain Management', keywords: ['supply chain jobs', 'logistics management'] },
  { name: 'Warehouse Management', keywords: ['warehouse jobs', 'warehouse operations'] },
  { name: 'Logistics Management', keywords: ['logistics jobs', 'transport management'] },
  { name: 'Quality Management Systems', keywords: ['qms jobs', 'quality systems'] },
  { name: 'ISO Standards', keywords: ['iso jobs', 'quality standards'] },
];

// Map industry-specific functional areas
const functionalAreaIndustryMap = {};
industrySpecificFunctionalAreasData.forEach(fa => {
    functionalAreaIndustryMap[fa.name] = fa.industryName;
});

// Validate that all roles have valid functional areas
const validFunctionalAreas = new Set(functionalAreasData.map(f => f.name));
for (const role of rolesData) {
    if (!validFunctionalAreas.has(role.functionalAreaName)) {
        throw new Error(`❌ Role "${role.name}" has invalid Functional Area "${role.functionalAreaName}"`);
    }
}

// ----------------- SEED FUNCTION -----------------
async function seed() {
    try {
        console.log('Starting enhanced seeding process...');

        const requestedReset = process.env.SEED_RESET === 'true' || process.argv.includes('--reset');
        const allowDestructiveReset = process.env.ALLOW_SEED_RESET === 'true';
        const isProduction = process.env.NODE_ENV === 'production';
        const shouldReset = requestedReset && allowDestructiveReset && !isProduction;

        if (requestedReset && !shouldReset) {
            console.log('Reset request ignored for safety. To allow reset, set ALLOW_SEED_RESET=true and ensure NODE_ENV is not production.');
        }

        if (shouldReset) {
            await Industry.deleteMany({});
            await FunctionalArea.deleteMany({});
            await Role.deleteMany({});
            await Location.deleteMany({});
            await Skill.deleteMany({});
            console.log('Cleared existing data (--reset mode)');
        } else {
            console.log('Safe mode enabled: upsert only (no delete)');
        }

        // Utility to generate unique slug for a list (locations/skills can repeat names)
        function generateUniqueSlug(name, slugSet) {
            const baseSlug = generateSlug(name);
            let slug = baseSlug;
            let counter = 1;
            while (slugSet.has(slug)) {
                slug = `${baseSlug}-${counter}`;
                counter++;
            }
            slugSet.add(slug);
            return slug;
        }

        // 1. Seed Industries
        const industriesMap = {};
        for (const ind of industriesData) {
            const slug = generateSlug(ind.name);
            const saved = await Industry.findOneAndUpdate(
                { slug },
                {
                    $set: {
                        name: ind.name,
                        slug,
                        keywords: ind.keywords || [],
                        isActive: true,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            industriesMap[ind.name] = saved._id;
        }
        console.log(`Seeded ${Object.keys(industriesMap).length} industries`);

        // 2. Seed Functional Areas
        const functionalAreasMap = {};

        for (const fa of globalFunctionalAreasData) {
            const saved = await FunctionalArea.findOneAndUpdate(
                { name: fa.name, industry: null },
                {
                    $set: {
                        name: fa.name,
                        slug: generateSlug(fa.name),
                        industry: null,
                        isGlobal: true,
                        keywords: fa.keywords || [],
                        isActive: true,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            functionalAreasMap[fa.name] = { id: saved._id, isGlobal: true };
        }

        for (const fa of industrySpecificFunctionalAreasData) {
            const industryId = industriesMap[fa.industryName];
            if (!industryId) throw new Error(`Industry not found for Functional Area "${fa.name}"`);

            const saved = await FunctionalArea.findOneAndUpdate(
                { name: fa.name, industry: industryId },
                {
                    $set: {
                        name: fa.name,
                        slug: generateSlug(fa.name),
                        industry: industryId,
                        isGlobal: false,
                        keywords: fa.keywords || [],
                        isActive: true,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            functionalAreasMap[fa.name] = { id: saved._id, isGlobal: false };
        }

        console.log(`Seeded ${functionalAreasData.length} functional areas`);

        // 3. Seed Roles (dedupe by role+functionalArea)
        const roleKeySet = new Set();
        const dedupedRoles = [];
        for (const role of rolesData) {
            const key = `${role.name.toLowerCase()}__${role.functionalAreaName}`;
            if (!roleKeySet.has(key)) {
                roleKeySet.add(key);
                dedupedRoles.push(role);
            }
        }
        console.log(`Deduped roles: ${rolesData.length} -> ${dedupedRoles.length}`);

        const roleCounts = { common: 0, industrySpecific: 0 };
        for (const role of dedupedRoles) {
            const faInfo = functionalAreasMap[role.functionalAreaName];
            if (!faInfo) throw new Error(`Functional Area not found for role "${role.name}"`);

            const slug = generateSlug(role.name);
            const isGlobal = role.isGlobal || faInfo.isGlobal;

            await Role.findOneAndUpdate(
                { name: role.name, functionalArea: faInfo.id },
                {
                    $set: {
                        name: role.name,
                        slug,
                        functionalArea: faInfo.id,
                        isGlobal,
                        keywords: role.keywords || [],
                        alternativeNames: role.alternativeNames || [],
                        isActive: true,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            if (isGlobal) roleCounts.common++;
            else roleCounts.industrySpecific++;
        }
        console.log(`Seeded ${dedupedRoles.length} roles (${roleCounts.common} common, ${roleCounts.industrySpecific} industry-specific)`);

        // 4. Seed Locations
        const locationSlugSet = new Set();
        for (const loc of locationsData) {
            const slug = generateUniqueSlug(loc.name, locationSlugSet);
            await Location.findOneAndUpdate(
                { name: loc.name },
                {
                    $set: {
                        name: loc.name,
                        slug,
                        state: loc.state || '',
                        keywords: loc.keywords || [],
                        isActive: true,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }
        console.log(`Seeded ${locationsData.length} locations`);

        // 5. Seed Skills
        const skillSlugSet = new Set();
        for (const skill of skillsData) {
            const slug = generateUniqueSlug(skill.name, skillSlugSet);
            await Skill.findOneAndUpdate(
                { name: skill.name },
                {
                    $set: {
                        name: skill.name,
                        slug,
                        category: skill.category || '',
                        keywords: skill.keywords || [],
                        isActive: true,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }
        console.log(`Seeded ${skillsData.length} skills`);

        // 6. Verification Report
        console.log('\nVerification Report:');
        for (const industryName in industriesMap) {
            const industryId = industriesMap[industryName];

            const functionalAreasCount = await FunctionalArea.countDocuments({
                $or: [{ industry: industryId }, { isGlobal: true }],
            });

            const rolesCount = await Role.countDocuments({
                functionalArea: {
                    $in: await FunctionalArea.find({
                        $or: [{ industry: industryId }, { isGlobal: true }],
                    }).distinct('_id'),
                },
            });

            console.log(`   ${industryName}: ${functionalAreasCount} functional areas, ${rolesCount} roles`);
        }

        console.log('\nEnhanced seeding complete successfully!');
        console.log('All industries now have functional areas and roles');

        process.exit(0);
    } catch (error) {
        console.error('Seeding failed:', error);
        process.exit(1);
    }
}
seed();

