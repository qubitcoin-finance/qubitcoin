import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/api-responses.json'), 'utf-8')
);

const SAMPLE_BLOCK_HASH = fixtures.block.hash;
const SAMPLE_TX_ID = fixtures.tx.id;
const SAMPLE_ADDRESS = fixtures.addressUtxos[0].address;

/** Mock all API routes to succeed (baseline) */
async function mockApiSuccess(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/status') return route.fulfill({ json: fixtures.status });
    if (path === '/api/v1/blocks') return route.fulfill({ json: fixtures.blocks });
    if (path.startsWith('/api/v1/block/')) return route.fulfill({ json: fixtures.block });
    if (path.startsWith('/api/v1/tx/')) return route.fulfill({ json: fixtures.tx });
    if (path === '/api/v1/mempool/stats') return route.fulfill({ json: fixtures.mempoolStats });
    if (path.startsWith('/api/v1/mempool/txs')) return route.fulfill({ json: fixtures.mempoolTxs });
    if (path === '/api/v1/claims/stats') return route.fulfill({ json: fixtures.claimStats });
    if (path.match(/\/api\/v1\/address\/[^/]+\/balance/)) return route.fulfill({ json: fixtures.addressBalance });
    if (path.match(/\/api\/v1\/address\/[^/]+\/utxos/)) return route.fulfill({ json: fixtures.addressUtxos });
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

/** Mock API to abort all requests (network error) */
async function mockApiNetworkError(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => route.abort('connectionrefused'));
}

/** Mock API to return 404 for address endpoints */
async function mockApiAddress404(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.match(/\/api\/v1\/address\//)) {
      return route.fulfill({ status: 404, json: { error: 'not found' } });
    }
    return route.fulfill({ json: {} });
  });
}

/** Mock API to return 404 for block endpoint, and also for tx (no disambiguation) */
async function mockApiBlock404(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/block/') || path.startsWith('/api/v1/tx/')) {
      return route.fulfill({ status: 404, json: { error: 'not found' } });
    }
    return route.fulfill({ json: {} });
  });
}

/** Mock API to return 404 for tx endpoint */
async function mockApiTx404(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/tx/')) {
      return route.fulfill({ status: 404, json: { error: 'not found' } });
    }
    return route.fulfill({ json: {} });
  });
}

test.describe('Address view — API error handling', () => {
  test('shows balance and UTXOs on success', async ({ page }) => {
    await mockApiSuccess(page);
    await page.goto(`/#/address/${SAMPLE_ADDRESS}`, { waitUntil: 'networkidle' });

    await expect(page.locator('#explorer-content')).toContainText('QBTC');
    await expect(page.locator('#explorer-content')).toContainText('UTXOs (1)');
  });

  test('shows connection error when network is down', async ({ page }) => {
    await mockApiNetworkError(page);
    await page.goto(`/#/address/${SAMPLE_ADDRESS}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    await expect(page.locator('#explorer-content')).toContainText('Unable to reach the node');
    await expect(page.locator('#explorer-content button')).toContainText('Retry');
  });

  test('shows partial error when only balance fails', async ({ page }) => {
    // Balance returns 500, UTXOs succeed
    await page.route('**/api/v1/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.match(/\/api\/v1\/address\/[^/]+\/balance/)) {
        return route.fulfill({ status: 500, json: { error: 'server error' } });
      }
      if (path.match(/\/api\/v1\/address\/[^/]+\/utxos/)) {
        return route.fulfill({ json: fixtures.addressUtxos });
      }
      return route.fulfill({ json: {} });
    });

    await page.goto(`/#/address/${SAMPLE_ADDRESS}`, { waitUntil: 'networkidle' });

    // Should show the error for balance but still render UTXOs
    await expect(page.locator('#explorer-content')).toContainText('Unable to load balance');
    await expect(page.locator('#explorer-content')).toContainText('UTXOs (1)');
  });

  test('shows partial error when only UTXOs fail', async ({ page }) => {
    await page.route('**/api/v1/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.match(/\/api\/v1\/address\/[^/]+\/balance/)) {
        return route.fulfill({ json: fixtures.addressBalance });
      }
      if (path.match(/\/api\/v1\/address\/[^/]+\/utxos/)) {
        return route.fulfill({ status: 500, json: { error: 'server error' } });
      }
      return route.fulfill({ json: {} });
    });

    await page.goto(`/#/address/${SAMPLE_ADDRESS}`, { waitUntil: 'networkidle' });

    // Balance should show fine, UTXOs should show error
    await expect(page.locator('#explorer-content')).toContainText('QBTC');
    await expect(page.locator('#explorer-content')).toContainText('Unable to load UTXOs');
  });
});

test.describe('Block view — API error handling', () => {
  test('shows connection error when network is down', async ({ page }) => {
    await mockApiNetworkError(page);
    await page.goto(`/#/block/${SAMPLE_BLOCK_HASH}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    await expect(page.locator('#explorer-content')).toContainText('Unable to reach the node');
  });

  test('shows "not found" for 404 block', async ({ page }) => {
    await mockApiBlock404(page);
    await page.goto('/#/block/0000deadbeef', { waitUntil: 'networkidle' });

    await expect(page.locator('#explorer-content')).toContainText('Block not found');
  });
});

test.describe('Transaction view — API error handling', () => {
  test('shows connection error when network is down', async ({ page }) => {
    await mockApiNetworkError(page);
    await page.goto(`/#/tx/${SAMPLE_TX_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    await expect(page.locator('#explorer-content')).toContainText('Unable to reach the node');
  });

  test('shows "not found" for 404 tx', async ({ page }) => {
    await mockApiTx404(page);
    await page.goto('/#/tx/deadbeef1234', { waitUntil: 'networkidle' });

    await expect(page.locator('#explorer-content')).toContainText('Transaction not found');
  });
});
