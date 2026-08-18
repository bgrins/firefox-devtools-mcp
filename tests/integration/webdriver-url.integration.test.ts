/**
 * Integration tests for remote WebDriver mode (--webdriver-url)
 *
 * Runs a local geckodriver and drives it through the remote code path, so the
 * test exercises the same Builder().usingServer() flow a hosted endpoint would
 * take without depending on any external service.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { FirefoxClient } from '@/firefox/index.js';
import { closeFirefox } from '../helpers/firefox.js';

const GECKODRIVER_PORT = 4455;
const webdriverUrl = `http://127.0.0.1:${GECKODRIVER_PORT}`;

async function waitForGeckodriver(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${webdriverUrl}/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`geckodriver did not start listening on port ${GECKODRIVER_PORT}`);
}

describe('Remote WebDriver Integration Tests', () => {
  let geckodriver: ChildProcess;
  let firefox: FirefoxClient;

  beforeAll(async () => {
    const { start } = await import('geckodriver');
    geckodriver = await start({ port: GECKODRIVER_PORT });
    await waitForGeckodriver();

    firefox = new FirefoxClient({
      webdriverUrl,
      headless: true,
      viewport: { width: 1024, height: 768 },
      prefs: { 'general.useragent.override': 'remote-webdriver-integration-test' },
    });
    await firefox.connect();
  }, 60000);

  afterAll(async () => {
    await closeFirefox(firefox);
    geckodriver?.kill();
  });

  it('creates a session without launching Firefox locally', () => {
    expect(firefox.getFirefoxVersion()).toBeTruthy();
  });

  it('exposes BiDi, which most tools depend on', async () => {
    const title = await firefox.evaluate('document.title');
    expect(typeof title).toBe('string');
  });

  it('applies prefs passed to the remote endpoint', async () => {
    const userAgent = await firefox.evaluate('navigator.userAgent');
    expect(userAgent).toBe('remote-webdriver-integration-test');
  });

  it('navigates and reads page content over the remote session', async () => {
    await firefox.navigate('data:text/html,<title>Remote</title><h1>hello remote</h1>');

    expect(await firefox.evaluate('document.title')).toBe('Remote');
    expect(await firefox.evaluate('document.querySelector("h1").textContent')).toBe('hello remote');
  }, 20000);

  it('reports the remote endpoint in the launch options', () => {
    expect(firefox.getOptions().webdriverUrl).toBe(webdriverUrl);
  });
});
