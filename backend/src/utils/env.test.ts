import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { jwtSecret, isProduction } from './env';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.NODE_ENV = process.env.NODE_ENV;
  saved.JWT_SECRET = process.env.JWT_SECRET;
});
afterEach(() => {
  if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.NODE_ENV;
  if (saved.JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved.JWT_SECRET;
});

describe('jwtSecret — no silent dev-secret in production', () => {
  it('returns the configured secret when set', () => {
    process.env.JWT_SECRET = 'real-secret';
    expect(jwtSecret()).toBe('real-secret');
  });

  it('falls back to dev-secret only outside production', () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'test';
    expect(jwtSecret()).toBe('dev-secret');
  });

  it('throws in production when the secret is missing', () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    expect(isProduction()).toBe(true);
    expect(() => jwtSecret()).toThrow(/JWT_SECRET/);
  });
});
