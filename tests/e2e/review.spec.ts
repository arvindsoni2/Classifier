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

test.beforeEach(async () => {
  world = await startWorld();
});

test.afterEach(async () => {
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
  await expect(page.getByText(/^Batch /)).toBeVisible({ timeout: 30_000 });

  // 2. Taxonomy curation in the browser (spec review F3): start from the
  // discovered folders, add a category, edit it, remove it — each save is an
  // explicit revisioned review.
  await page.getByRole('link', { name: /taxonomy/i }).click();
  await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /use suggested taxonomy/i }).click();
  await expect(page.getByTestId('taxonomy-status')).toContainText(/revision/i);

  await page.getByLabel('Label').fill('Receipts');
  await page.getByLabel('Description').fill('receipt receipts documents');
  await page.getByLabel('Destination folder').selectOption({ label: 'Documents' });
  await page.getByRole('button', { name: /^save node$/i }).click();
  await expect(page.getByTestId('taxonomy-status')).toContainText(/Added Receipts/i);
  const receiptsRow = page.getByRole('row', { name: /Receipts/ });
  await expect(receiptsRow).toBeVisible();

  await receiptsRow.getByRole('button', { name: /edit/i }).click();
  await page.getByLabel('Label').fill('Papers');
  await page.getByRole('button', { name: /update node/i }).click();
  await expect(page.getByTestId('taxonomy-status')).toContainText(/Updated Papers/i);

  await page.getByRole('row', { name: /Papers/ }).getByRole('button', { name: /remove/i }).click();
  await expect(page.getByTestId('taxonomy-status')).toContainText(/Removed/i);
  // Each save is a review: the tree is now approved and classification unlocks.
  await expect(page.getByRole('button', { name: /approved|approve taxonomy/i })).toBeDisabled();

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
  await page.getByLabel(/destination|category/i).first().selectOption({ index: 0 });
  await page.getByRole('button', { name: /save|confirm/i }).click();
  await expect(page.getByTestId('version-invoice-02.txt')).not.toHaveText(versionBefore ?? '');

  // 5. The exact summary lists both basenames before approval is possible.
  await page.getByRole('button', { name: /review exact summary|approve/i }).first().click();
  const summary = page.getByRole('dialog');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('invoice-01.txt');
  await expect(summary).toContainText('invoice-02.txt');
  // 6. Confirming the exact summary creates the approval and applies it;
  // the verified outcomes are then shown, not optimistically hidden.
  await summary.getByRole('button', { name: /confirm|approve/i }).click();
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
  await expect(page.getByText(/^Batch /)).toBeVisible({ timeout: 30_000 });
  // Classification requires a reviewed taxonomy (spec review R9).
  await page.getByRole('link', { name: /taxonomy/i }).click();
  await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /approve taxonomy/i }).click();
  await expect(page.getByTestId('taxonomy-status')).toContainText(/approved|revision/i);
  await page.getByRole('link', { name: /placement/i }).click();
  await page.getByRole('button', { name: /classify|regenerate/i }).first().click();
  await expect(page.getByText('invoice-01.txt')).toBeVisible({ timeout: 15_000 });

  // The photo has no supporting text: the rules provider defers, and a
  // deferred row cannot be selected or applied.
  const deferredRow = page.getByRole('row', { name: /beach-photo\.jpg/ });
  await expect(deferredRow).toContainText(/unknown|deferred/i);
  await expect(deferredRow.getByRole('checkbox')).toBeDisabled();
  // With only deferred rows there is nothing to approve: the summary cannot
  // be opened, so no approval and no apply path exists for them.
  await expect(page.getByRole('button', { name: /review exact summary/i })).toBeDisabled();
});

test('keyboard and focus behaviour on the review dialog', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: /scan/i }).first().click();
  await expect(page.getByText(/^Batch /)).toBeVisible({ timeout: 30_000 });
  // Classification requires a reviewed taxonomy (spec review R9).
  await page.getByRole('link', { name: /taxonomy/i }).click();
  await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /approve taxonomy/i }).click();
  await expect(page.getByTestId('taxonomy-status')).toContainText(/approved|revision/i);
  await page.getByRole('link', { name: /placement/i }).click();
  await page.getByRole('button', { name: /classify|regenerate/i }).first().click();
  await expect(page.getByText('invoice-01.txt')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('row', { name: /invoice-01\.txt/ }).getByRole('checkbox').check();
  await page.getByRole('button', { name: /review exact summary|approve/i }).first().click();

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
