// Ensures `src/config/env.ts` validation passes when service modules are
// imported by unit tests, without requiring a real `.env` file.
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/edutrack_test';
process.env.JWT_SECRET ??= 'test-secret-key-not-for-production-use';
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
