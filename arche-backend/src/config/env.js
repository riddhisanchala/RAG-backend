// Central place that reads and validates environment variables.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function required(name) {
  const v = process.env[name];
  if (!v || v.startsWith('change-me')) {
    console.error(`❌ Missing required environment variable ${name}. See backend/.env.example`);
    process.exit(1);
  }
  return v;
}

const encryptionKey = required('ENCRYPTION_KEY');
if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  console.error('❌ ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  process.exit(1);
}

export const env = {
  port: Number(process.env.PORT) || 5000,
  mongoUri: required('MONGO_URI'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  encryptionKey: Buffer.from(encryptionKey, 'hex'),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
  dataDir: path.resolve(BACKEND_ROOT, process.env.DATA_DIR || './data'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 25,
  // Optional. When empty, "Continue with Google" is disabled. Create an OAuth 2.0 Web client at console.cloud.google.com.
  googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  seedDefaultUsers: process.env.SEED_DEFAULT_USERS !== 'false',
  topK: Number(process.env.RETRIEVAL_TOP_K) || 6,
  minScore: Number(process.env.RETRIEVAL_MIN_SCORE ?? 0.12),
};
