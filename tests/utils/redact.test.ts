/**
 * Tests for URL credential redaction
 */

import { describe, it, expect } from 'vitest';
import { redactUrlCredentials } from '@/utils/redact.js';

describe('redactUrlCredentials', () => {
  it('replaces the password while keeping the endpoint readable', () => {
    expect(redactUrlCredentials('https://api:s3cret@example.test/wd/hub')).toBe(
      'https://api:***@example.test/wd/hub'
    );
  });

  it('leaves URLs without credentials unchanged', () => {
    expect(redactUrlCredentials('http://127.0.0.1:4444')).toBe('http://127.0.0.1:4444');
    expect(redactUrlCredentials('https://example.test/wd/hub')).toBe('https://example.test/wd/hub');
  });

  it('keeps a username, which is not the secret', () => {
    expect(redactUrlCredentials('https://api@example.test/wd')).toBe('https://api@example.test/wd');
  });

  it('redacts a password containing URL-significant characters', () => {
    const redacted = redactUrlCredentials('https://api:p%40ss%2Fword@example.test/wd');
    expect(redacted).toBe('https://api:***@example.test/wd');
    expect(redacted).not.toContain('ss%2Fword');
  });

  it('withholds unparseable input, which may still hide credentials', () => {
    expect(redactUrlCredentials('not a url')).toBe('<invalid url>');
  });
});
