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

const BASE_DTO = {
  email: 'ada@example.com',
  password: 'SecurePass123',
  name: 'Ada Lovelace',
  role: 'STUDENT' as const,
};

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe('AuthService.register', () => {
  let service: AuthService;

  beforeEach(() => { service = new AuthService(); jest.clearAllMocks(); });

  it('(a) returns the created user without a password field', async () => {
    db.user.create.mockResolvedValue({ id: 'u1', email: BASE_DTO.email, name: BASE_DTO.name, role: 'STUDENT' });
    const result = await service.register(BASE_DTO);
    expect(result.id).toBe('u1');
    expect(result.email).toBe(BASE_DTO.email);
    expect((result as unknown as Record<string, unknown>)['password']).toBeUndefined();
  });

  it('(b) stores a hashed password — different from the plain-text input', async () => {
    let captured = '';
    db.user.create.mockImplementation((args: { data: { password: string } }) => {
      captured = args.data.password;
      return Promise.resolve({ id: 'u1', email: BASE_DTO.email, name: BASE_DTO.name, role: 'STUDENT' });
    });
    await service.register(BASE_DTO);
    expect(captured).not.toBe(BASE_DTO.password);
    // scrypt output: <salt_hex>:<derived_hex>
    expect(captured).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('(c) passes the correct role to Prisma', async () => {
    db.user.create.mockResolvedValue({ id: 'u1', email: BASE_DTO.email, name: BASE_DTO.name, role: 'INSTRUCTOR' });
    await service.register({ ...BASE_DTO, role: 'INSTRUCTOR' });
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'INSTRUCTOR' }) }),
    );
  });

  it('(d) throws ConflictError 409 on duplicate email (P2002)', async () => {
    db.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: '5.x' }),
    );
    await expect(service.register(BASE_DTO)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.register(BASE_DTO)).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' });
  });

  it('(e) re-throws unexpected errors unwrapped', async () => {
    db.user.create.mockRejectedValue(new Error('DB down'));
    await expect(service.register(BASE_DTO)).rejects.toThrow('DB down');
  });
});

// ---------------------------------------------------------------------------
// validateCredentials()
// ---------------------------------------------------------------------------

describe('AuthService.validateCredentials', () => {
  let service: AuthService;

  beforeEach(() => { service = new AuthService(); jest.clearAllMocks(); });

  it('(a) throws UnauthorizedError 401 when user does not exist', async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(service.validateCredentials('x@x.com', 'p')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.validateCredentials('x@x.com', 'p')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('(b) throws UnauthorizedError 401 on wrong password', async () => {
    // Syntactically valid but non-matching hash
    db.user.findUnique.mockResolvedValue({
      id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'STUDENT',
      password: 'aabbccddeeff00112233445566778899:' + 'ff'.repeat(64),
    });
    await expect(service.validateCredentials('ada@example.com', 'WrongPass')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('(c) throws UnauthorizedError 401 when stored hash is malformed', async () => {
    db.user.findUnique.mockResolvedValue({
      id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'STUDENT',
      password: 'not-a-valid-hash',
    });
    await expect(service.validateCredentials('ada@example.com', 'anything')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('(d) returns the authenticated principal on valid credentials', async () => {
    // Register a real hash first, then validate against it
    let storedHash = '';
    db.user.create.mockImplementation((args: { data: { password: string } }) => {
      storedHash = args.data.password;
      return Promise.resolve({ id: 'u1', email: BASE_DTO.email, name: BASE_DTO.name, role: 'STUDENT' });
    });
    await new AuthService().register(BASE_DTO);

    db.user.findUnique.mockResolvedValue({
      id: 'u1', email: BASE_DTO.email, name: BASE_DTO.name, role: 'STUDENT',
      password: storedHash,
    });

    const result = await service.validateCredentials(BASE_DTO.email, BASE_DTO.password);
    expect(result.id).toBe('u1');
    expect(result.email).toBe(BASE_DTO.email);
    expect((result as unknown as Record<string, unknown>)['password']).toBeUndefined();
  });
});