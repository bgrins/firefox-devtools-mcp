// Shared by run.mjs (npm start) and test/parity.mjs. Based on marionette's
// quiet-startup set (testing/marionette/client geckoinstance.py); each non-obvious
// entry is annotated.
export const QUIET_STARTUP_PREFS = [
  "termsofuse.bypassNotification=true",
  // Bug 2050570: the preonboarding splash shows on fresh profiles even with the
  // ToU bypass and wedges tab visibility transitions, hanging
  // browsingContext.create/activate (untimed _awaitVisibilityState waits).
  "browser.preonboarding.enabled=false",
  "datareporting.policy.dataSubmissionPolicyBypassNotification=true",
  "app.normandy.enabled=false",
  "app.update.disabledForTesting=true",
  "browser.shell.checkDefaultBrowser=false",
  "browser.startup.homepage=about:blank",
  "startup.homepage_welcome_url=about:blank",
  // A second dialog within 3s becomes "confirmCheck" (abuse checkbox), which BiDi
  // handleUserPrompt refuses.
  "dom.successive_dialog_time_limit=0",
];

export const EXTENSION_PREFS = (port) => [
  "extensions.experiments.enabled=true",
  "extensions.bidibridge.autostart=true",
  `extensions.bidibridge.port=${port}`,
];

export const prefArgs = (prefs) => prefs.map((p) => `--pref=${p}`);
