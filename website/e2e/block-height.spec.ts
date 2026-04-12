import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/api-responses.json'), 'utf-8')
);

const SAMPLE_BLOCK_HASH = fixtures.block.hash;
const SAMPLE_BLOCK_HEIGHT = fixtures.block.height;

async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/status') return route.fulfill({ json: fixtures.status });
    if (path === '/api/v1/blocks') return route.fulfill({ json: fixtures.blocks });
    if (path.startsWith('/api/v1/block/')) return route.fulfill({ json: fixtures.block });
    if (path === '/api/v1/mempool/stats') return route.fulfill({ json: fixtures.mempoolStats });
    if (path.startsWith('/api/v1/mempool/txs')) return route.fulfill({ json: fixtures.mempoolTxs });
    if (path === '/api/v1/claims/stats') return route.fulfill({ json: fixtures.claimStats });
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

test.describe('Block detail — height display', () => {
  test('page heading includes block height', async ({ page }) => {
    await mockApi(page);
    await page.goto(`/#/block/${SAMPLE_BLOCK_HASH}`, { waitUntil: 'networkidle' });

    const heading = page.locator('#explorer-content h1');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(`#${SAMPLE_BLOCK_HEIGHT}`);
  });

  test('block detail card shows Height field', async ({ page }) => {
    await mockApi(page);
    await page.goto(`/#/block/${SAMPLE_BLOCK_HASH}`, { waitUntil: 'networkidle' });

    // The height label should appear in the detail card
    const heightLabel = page.locator('#explorer-content p.text-text-muted', { hasText: 'Height' }).first();
    await expect(heightLabel).toBeVisible();

    // The height value (formatted with toLocaleString) should be present
    const heightValue = page.locator('#explorer-content p.font-mono', { hasText: SAMPLE_BLOCK_HEIGHT.toLocaleString() }).first();
    await expect(heightValue).toBeVisible();
  });
});

test.describe('Recent blocks table — height column', () => {
  test('Height column header is present in Recent Blocks table', async ({ page }) => {
    await mockApi(page);
    await page.goto('/#/mempool', { waitUntil: 'networkidle' });

    const heightHeader = page.locator('#explorer-content th', { hasText: 'Height' });
    await expect(heightHeader).toBeVisible();
  });

  test('each row in Recent Blocks shows a #N height link', async ({ page }) => {
    await mockApi(page);
    await page.goto('/#/mempool', { waitUntil: 'networkidle' });

    // The first block in the fixture list should have its height shown as a link
    const firstBlock = fixtures.blocks[0];
    const heightLink = page.locator(`#explorer-content td a[href="#/block/${firstBlock.hash}"]`, {
      hasText: `#${firstBlock.height}`,
    }).first();
    await expect(heightLink).toBeVisible();
  });
});
