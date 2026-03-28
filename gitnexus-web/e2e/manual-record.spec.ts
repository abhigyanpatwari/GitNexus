import { test } from '@playwright/test';

/**
 * Manual recording session for interactive debugging.
 * Opens the app and pauses so you can interact with the UI.
 * Trace, video, and screenshots are saved automatically on close.
 *
 * Run with: npx playwright test e2e/manual-record.spec.ts --headed --timeout=0
 *
 * Excluded from `npm run test:e2e` via testIgnore in playwright.config.ts.
 * Also skipped when PWDEBUG is not set or in CI, as a safety net.
 */
test.skip(
  !!process.env.CI || process.env.PWDEBUG !== '1',
  'Manual recording requires --headed and PWDEBUG=1. Run: PWDEBUG=1 npx playwright test e2e/manual-record.spec.ts --headed --timeout=0',
);

test('manual recording session', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => console.log(`[crash] ${err.message}`));

  await page.goto('http://localhost:5173');
  await page.pause();
});
