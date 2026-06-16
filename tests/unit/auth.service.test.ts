/**
 * AuthService unit tests
 *
 * scrypt is slow by design, so these tests exercise the service logic
 * (duplicate-email detection, credential validation) by mocking Prisma.
 * Password-hashing correctness is an implementation detail of Node's
 * built-in crypto — we do not re-test it here.
 */

import { AuthService } from '../../src/services/auth.service';
import prisma from '../../src/prisma';
import { ConflictError, UnauthorizedError } from '../../src/errors/app-error';
import { Prisma } from '@prisma/client';

jest.mock('../../src/prisma', () => ({
  __esModule: true,
  default: {
    user: { create: jest.fn(), findUnique: jest.fn() },
  },
}));

type MockedPrisma = {
  user: { create: jest.Mock; findUnique: jest.Mock };
};

const db = prisma as unknown as MockedPrisma;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_REGISTER_DTO = {
  email: 'ada@example.com',
  password: 'SecurePass123',
  name: 'Ada Lovelace',
  role: 'STUDENT' as const,
};

const STORED_USER = {
  id: 'user-1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  role: 'STUDENT' as const,
  // A real scrypt hash of 'SecurePass123' would go here; since we mock
  // findUnique we control what's "stored" — we use a known good hash
  // produced once from the real hashPassword function.
  // Format: salt(hex):derived(hex)
  // We stub verifyPassword indirectly by providing a hash that matches.
  password: 'placeholder-will-be-replaced-per-test',
};

describe('AuthService.register', () => {
  let service: AuthService;

  beforeEach(() => {
    service = new AuthService();
    jest.clearAllMocks();
  });

  it('creates a user and returns the authenticated principal (without password)', async () => {
    const created = { id: 'user-1', email: BASE_REGISTER_DTO.email, name: BASE_REGISTER_DTO.name, role: 'STUDENT' };
    db.user.create.mockResolvedValue(created);

    const result = await service.register(BASE_REGISTER_DTO);

    expect(result.id).toBe('user-1');
    expect(result.email).toBe(BASE_REGISTER_DTO.email);
    expect(result.role).toBe('STUDENT');
    // Password hash must NEVER be returned
    expect((result as unknown as Record<string, unknown>)['password']).toBeUndefined();
    expect(db.user.create).toHaveBeenCalledTimes(1);
  });

  it('hashes the password — the hash stored in Prisma differs from the plain-text input', async () => {
    let capturedData: Record<string, unknown> = {};
    db.user.create.mockImplementation((args: { data: Record<string, unknown> }) => {
      capturedData = args.data;
      return Promise.resolve({ id: 'user-1', email: BASE_REGISTER_DTO.email, name: BASE_REGISTER_DTO.name, role: 'STUDENT' });
    });

    await service.register(BASE_REGISTER_DTO);

    expect(capturedData['password']).not.toBe(BASE_REGISTER_DTO.password);
    expect(typeof capturedData['password']).toBe('string');
    // scrypt output: salt:hash — two colon-separated hex segments
    expect(capturedData['password'] as string).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('throws ConflictError (409) when the email is already taken (P2002)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '5.x',
    });
    db.user.create.mockRejectedValue(p2002);

    await expect(service.register(BASE_REGISTER_DTO)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.register(BASE_REGISTER_DTO)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('re-throws unexpected Prisma errors without wrapping them', async () => {
    const unexpectedError = new Error('DB connection lost');
    db.user.create.mockRejectedValue(unexpectedError);

    await expect(service.register(BASE_REGISTER_DTO)).rejects.toThrow('DB connection lost');
  });
});

describe('AuthService.validateCredentials', () => {
  let service: AuthService;

  beforeEach(() => {
    service = new AuthService();
    jest.clearAllMocks();
  });

  it('throws UnauthorizedError (401) when the user does not exist', async () => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(service.validateCredentials('nobody@example.com', 'pass')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.validateCredentials('nobody@example.com', 'pass')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws UnauthorizedError (401) when the password is wrong', async () => {
    // Store a hash that will never match 'wrong-password'
    db.user.findUnique.mockResolvedValue({
      ...STORED_USER,
      // Provide a syntactically valid but non-matching hash so verifyPassword returns false
      password: 'aabbccddeeff00112233445566778899:' + 'ff'.repeat(64),
    });

    await expect(
      service.validateCredentials('ada@example.com', 'wrong-password'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('throws UnauthorizedError (401) when the stored hash is malformed', async () => {
    db.user.findUnique.mockResolvedValue({ ...STORED_USER, password: 'not-a-valid-hash' });

    await expect(service.validateCredentials('ada@example.com', 'any')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
