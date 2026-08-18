/**
 * Tests for remote WebDriver mode (--webdriver-url)
 */

import { describe, it, expect } from 'vitest';
import { FirefoxCore } from '@/firefox/core.js';

describe('FirefoxCore remote WebDriver mode', () => {
  describe('conflicting modes', () => {
    it('rejects --webdriver-url combined with --connect-existing', async () => {
      const core = new FirefoxCore({
        webdriverUrl: 'https://example.test/wd',
        connectExisting: true,
      });

      await expect(core.connect()).rejects.toThrow(/cannot be combined with --connect-existing/);
    });

    it('rejects --webdriver-url combined with --android-device', async () => {
      const core = new FirefoxCore({
        webdriverUrl: 'https://example.test/wd',
        androidDevice: 'emulator-5554',
        androidWipeAppData: true,
      });

      await expect(core.connect()).rejects.toThrow(/cannot be combined with --android-device/);
    });
  });

  describe('capability building', () => {
    const remoteOptions = { webdriverUrl: 'https://example.test/wd' };

    it('requests a BiDi endpoint', () => {
      const core = new FirefoxCore(remoteOptions);
      expect(core.buildRemoteFirefoxOptions().get('webSocketUrl')).toBe(true);
    });

    it('passes prefs and args to the remote geckodriver', () => {
      const core = new FirefoxCore({
        ...remoteOptions,
        prefs: { 'devtools.chrome.enabled': true, 'browser.startup.page': 3 },
        args: ['-foreground'],
      });

      const mozOptions = core.buildRemoteFirefoxOptions().get('moz:firefoxOptions') as {
        prefs: Record<string, unknown>;
        args: string[];
      };

      expect(mozOptions.prefs['devtools.chrome.enabled']).toBe(true);
      expect(mozOptions.prefs['browser.startup.page']).toBe(3);
      expect(mozOptions.args).toContain('-foreground');
    });

    it('forwards headless mode to the remote endpoint', () => {
      const mozOptions = new FirefoxCore({ ...remoteOptions, headless: true })
        .buildRemoteFirefoxOptions()
        .get('moz:firefoxOptions') as { args: string[] };

      expect(mozOptions.args).toContain('-headless');
    });

    it('translates viewport into window size arguments', () => {
      const core = new FirefoxCore({
        ...remoteOptions,
        viewport: { width: 1280, height: 720 },
      });

      const mozOptions = core.buildRemoteFirefoxOptions().get('moz:firefoxOptions') as {
        args: string[];
      };

      expect(mozOptions.args).toEqual(expect.arrayContaining(['--width=1280', '--height=720']));
    });

    it('omits acceptInsecureCerts unless requested', () => {
      expect(
        new FirefoxCore(remoteOptions).buildRemoteFirefoxOptions().get('acceptInsecureCerts')
      ).toBeUndefined();
      expect(
        new FirefoxCore({ ...remoteOptions, acceptInsecureCerts: true })
          .buildRemoteFirefoxOptions()
          .get('acceptInsecureCerts')
      ).toBe(true);
    });

    it('does not send local-only options to the remote endpoint', () => {
      const core = new FirefoxCore({
        ...remoteOptions,
        firefoxPath: '/local/path/to/firefox',
        profilePath: '/local/profile',
      });

      const capabilities = core.buildRemoteFirefoxOptions();
      const mozOptions = (capabilities.get('moz:firefoxOptions') ?? {}) as Record<string, unknown>;

      expect(mozOptions.binary).toBeUndefined();
      expect(mozOptions.profile).toBeUndefined();
    });
  });
});
