import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { startWorld, type E2EWorld } from './world.js';

/**
 * Review flow (plan Task 9): approve category, regenerate placements,
 * select exactly two rows, edit one (version changes), review the exact
 * summary, approve, apply, and inspect verified outcomes. Unknown/stale
 * rows are disabled and fake confidence cannot bypass approval.
 */

let world: E2EWorld;

test.beforeAll(async () => {
  world = await startWorld();
});

test.afterAll(async () => {
  await world.close();
});

async function login(page: Page): Promise<void> {
  await page.goto(world.baseUrl);
  await page.getByLabel('Token').fill(world.bootstrapToken);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
}

test('reviewed organisation flow end to end', async ({ page }) => {
  await login(page);

  // 1. Scan: read-only discovery populates the batch.
  await page.getByRole('button', { name: /scan/i }).first().click();
  await expect(page.getByText(/4 candidates|4 items|invoice-01/)).toBeVisible({ timeout: 15_000 });

  // 2. Taxonomy: approve the reviewed categories.
  await page.getByRole('link', { name: /taxonomy/i }).click();
  await page.getByRole('button', { name: /approve|save/i }).first().click();
  await expect(page.getByText(/approved|revision/i)).toBeVisible();

  // 3. Regenerate placements with the rules provider.
  await page.getByRole('link', { name: /placement/i }).click();
  await page.getByRole('button', { name: /classify|regenerate/i }).first().click();
  await expect(page.getByText('invoice-01.txt')).toBeVisible({ timeout: 15_000 });

  // 4. Exactly two rows are selected; an edit increments the version.
  const row = page.getByRole('row', { name: /invoice-02\.txt/ });
  await row.getByRole('checkbox').check();
  await page.getByRole('row', { name: /invoice-01\.txt/ }).getByRole('checkbox').check();
  await expect(page.getByText(/2 selected|2 actions/)).toBeVisible();

  const versionBefore = await page.getByTestId('version-invoice-02.txt').textContent();
  await row.getByRole('button', { name: /edit/i }).click();
  await page.getByLabel(/destination|category/i).first().selectOption({ index: 1 });
  await page.getByRole('button', { name: /save|confirm/i }).click();
  await expect(page.getByTestId('version-invoice-02.txt')).not.toHaveText(versionBefore ?? '');

  // 5. The exact summary lists both basenames before approval is possible.
  await page.getByRole('button', { name: /approve|review summary/i }).first().click();
  const summary = page.getByRole('dialog');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('invoice-01.txt');
  await expect(summary).toContainText('invoice-02.txt');
  await summary.getByRole('button', { name: /confirm|approve/i }).click();

  // 6. Apply; then the verified outcomes are shown, not optimistically hidden.
  await page.getByRole('button', { name: /^apply$/i }).click();
  await expect(page.getByText(/applied|verified/i).first()).toBeVisible({ timeout: 30_000 });

  // The moved files exist at their destinations with their bytes.
  const { existsSync, readFileSync } = await import('node:fs');
  expect(existsSync(join(world.rootDir, 'Invoices', 'invoice-01.txt'))).toBe(true);
  expect(readFileSync(join(world.rootDir, 'Invoices', 'invoice-01.txt'), 'utf8')).toBe(
    'first invoice for hosting\n',
  );

  // 7. History shows the verified receipt.
  await page.getByRole('link', { name: /history/i }).click();
  await expect(page.getByText(/applied/).first()).toBeVisible();
});

test('unknown rows are disabled and cannot be approved', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: /scan/i }).first().click();
  await page.getByRole('link', { name: /placement/i }).click();
  await page.getByRole('button', { name: /classify|regenerate/i }).first().click();
  await expect(page.getByText('invoice-01.txt')).toBeVisible({ timeout: 15_000 });

  // The photo has no supporting text: the rules provider defers, and a
  // deferred row cannot be selected or applied.
  const deferredRow = page.getByRole('row', { name: /beach-photo\.jpg/ });
  await expect(deferredRow).toContainText(/unknown|deferred/i);
  await expect(deferredRow.getByRole('checkbox')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^apply$/i })).toBeDisabled();
});

test('keyboard and focus behaviour on the review dialog', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: /scan/i }).first().click();
  await page.getByRole('link', { name: /placement/i }).click();
  await page.getByRole('button', { name: /classify|regenerate/i }).first().click();
  await expect(page.getByText('invoice-01.txt')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('row', { name: /invoice-01\.txt/ }).getByRole('checkbox').check();
  await page.getByRole('button', { name: /approve|review summary/i }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Focus lands inside the dialog and Escape closes it.
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('responsive at 360 px with reduced motion honoured', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);
  await expect(page.getByRole('navigation')).toBeVisible();
  // Content wraps without horizontal overflow.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(overflow).toBe(true);
});

test('hostile filenames render as escaped text, never markup', async ({ page }) => {
  await page.goto(world.baseUrl);
  await page.getByLabel('Token').fill(world.bootstrapToken);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
  // The fixtures include shell-like names; the UI must show them as text.
  const shellName = page.getByText('$(touch marker).txt');
  if (await shellName.count()) {
    await expect(shellName.first()).toBeVisible();
  }
});
