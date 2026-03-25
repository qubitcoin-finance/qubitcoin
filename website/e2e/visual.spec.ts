import { test, Page } from '@playwright/test';
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

/** Intercept all API calls and return fixture data */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/v1/status') {
      return route.fulfill({ json: fixtures.status });
    }
    if (path === '/api/v1/blocks') {
      return route.fulfill({ json: fixtures.blocks });
    }
    if (path.startsWith('/api/v1/block/')) {
      return route.fulfill({ json: fixtures.block });
    }
    if (path.startsWith('/api/v1/tx/')) {
      return route.fulfill({ json: fixtures.tx });
    }
    if (path === '/api/v1/mempool/stats') {
      return route.fulfill({ json: fixtures.mempoolStats });
    }
    if (path.startsWith('/api/v1/mempool/txs')) {
      return route.fulfill({ json: fixtures.mempoolTxs });
    }
    if (path === '/api/v1/claims/stats') {
      return route.fulfill({ json: fixtures.claimStats });
    }
    if (path.match(/\/api\/v1\/address\/[^/]+\/balance/)) {
      return route.fulfill({ json: fixtures.addressBalance });
    }
    if (path.match(/\/api\/v1\/address\/[^/]+\/utxos/)) {
      return route.fulfill({ json: fixtures.addressUtxos });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

/** Kill animations and reveal hidden elements for stable screenshots */
async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
      .reveal {
        opacity: 1 !important;
        transform: none !important;
      }
    `,
  });
  await page.waitForTimeout(200);
}

const routes = [
  { name: 'landing', hash: '' },
  { name: 'dashboard', hash: '#/mempool' },
  { name: 'block-detail', hash: `#/block/${SAMPLE_BLOCK_HASH}` },
  { name: 'tx-detail', hash: `#/tx/${SAMPLE_TX_ID}` },
  { name: 'address', hash: `#/address/${SAMPLE_ADDRESS}` },
  { name: 'docs', hash: '#/docs' },
  { name: 'docs-api', hash: '#/docs/api' },
];

for (const route of routes) {
  test(`${route.name}`, async ({ page }, testInfo) => {
    await mockApi(page);

    const url = route.hash ? `/${route.hash}` : '/';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Give the SPA router time to dispatch and render
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle');
    await stabilize(page);

    const viewport = testInfo.project.name;
    await page.screenshot({
      path: `tmp/screenshots/${viewport}/${route.name}.png`,
      fullPage: true,
    });
  });
}
