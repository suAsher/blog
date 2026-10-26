import { describe, expect, it } from 'vitest';
import { isIP } from 'node:net';
import { localClientAddress } from '../../scripts/local-private-server.mjs';

describe('temporary private QA client identities', () => {
  it('keeps anonymous login attempts on the same client address', () => {
    expect(localClientAddress(undefined)).toBe('127.0.0.1');
    expect(localClientAddress('theme=light')).toBe('127.0.0.1');
    expect(localClientAddress('__Host-asher_session=')).toBe('127.0.0.1');
  });

  it('uses one stable private IPv6 address for every request in a session', () => {
    const address = localClientAddress('__Host-asher_session=generated-qa-token');
    expect(isIP(address)).toBe(6);
    expect(address).toMatch(/^fd[0-9a-f]{2}:/);
    expect(localClientAddress('theme=light; __Host-asher_session=generated-qa-token; unrelated=value')).toBe(address);
  });

  it('assigns independent authenticated sessions independent limit budgets', () => {
    expect(localClientAddress('__Host-asher_session=generated-first-token')).not.toBe(localClientAddress('__Host-asher_session=generated-second-token'));
  });

  it('does not confuse another cookie name with the secure session cookie', () => {
    expect(localClientAddress('fake__Host-asher_session=generated-qa-token', '127.0.0.2')).toBe('127.0.0.2');
  });
});
