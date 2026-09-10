// config/aws-s3.js
import { S3Client } from "@aws-sdk/client-s3";
 
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
//   signatureVersion: 'v4',  // Force v4 signatures
//   forcePathStyle: false,   // Use DNS-style bucket access
});

// console.log('AWS S3 Client initialized with region:', process.env.AWS_REGION);
// console.log('AWS S3 Bucket:', process.env.AWS_S3_BUCKET);
// console.log('AWS Access Key ID:', process.env.AWS_ACCESS_KEY_ID );
// console.log('AWS Secret Access Key:', process.env.AWS_SECRET_ACCESS_KEY );

export { s3 };