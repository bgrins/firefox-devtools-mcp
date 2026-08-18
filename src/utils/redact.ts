/**
 * Credential redaction for URLs that may carry secrets
 */

/**
 * Replace the password in a URL's userinfo with a placeholder, so remote
 * endpoints can be logged and reported without leaking an API key. Returns the
 * input unchanged when it carries no password, and a bare placeholder when it
 * does not parse as a URL (an unparseable string may still hide credentials).
 */
export function redactUrlCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '<invalid url>';
  }

  if (!parsed.password) {
    return url;
  }

  parsed.password = '***';
  return parsed.toString();
}
