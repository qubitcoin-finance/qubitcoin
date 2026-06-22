import { expect, test, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/api-responses.json'), 'utf-8'),
) as {
  status: unknown;
  claimStats: Record<string, unknown>;
  snapshotAddress: Record<string, unknown>;
};

const PRIVATE_KEY_HEX = '0000000000000000000000000000000000000000000000000000000000000001';
const UNCOMPRESSED_WIF_LIKE = `5${'1'.repeat(50)}`;
const SNAPSHOT_ADDRESS = '751e76e8199196d454941c45d1b3a323f1433bd6';

function recordThirdPartyRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    requests.push(request.url());
  });
  return requests;
}

async function mockClaimApi(page: Page, postBodies: string[]): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === 'POST' && path === '/api/v1/tx') {
      postBodies.push(request.postData() ?? '');
      return route.fulfill({ json: { txid: 'd'.repeat(64) } });
    }
    if (path === '/api/v1/status') {
      return route.fulfill({ json: fixtures.status });
    }
    if (path === '/api/v1/claims/stats') {
      return route.fulfill({ json: fixtures.claimStats });
    }
    if (path.startsWith('/api/v1/snapshot/address/')) {
      return route.fulfill({
        json: {
          ...fixtures.snapshotAddress,
          btcAddress: SNAPSHOT_ADDRESS,
          type: 'p2pkh',
          claimed: false,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

test('builds and broadcasts a claim without sending the BTC key', async ({ page }) => {
  const postBodies: string[] = [];
  const thirdPartyRequests = recordThirdPartyRequests(page);
  await mockClaimApi(page, postBodies);

  await page.goto('/#/claim', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('BTC snapshot address key').fill(SNAPSHOT_ADDRESS);
  await page.getByRole('button', { name: 'Check Eligibility' }).click();
  await expect(page.locator('span').filter({ hasText: /^Eligible$/ }).first()).toBeVisible();

  await page.getByLabel('BTC private key or seed phrase').fill(PRIVATE_KEY_HEX);
  await page.getByRole('button', { name: 'Build Signed Claim' }).click();
  await expect(page.getByText('Signed claim transaction is ready')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('BTC private key or seed phrase')).toHaveValue('');

  await page.getByRole('button', { name: 'Broadcast', exact: true }).click();
  await expect(page.getByText('Broadcast accepted')).toBeVisible({ timeout: 20_000 });

  expect(postBodies).toHaveLength(1);
  expect(postBodies[0]).not.toContain(PRIVATE_KEY_HEX);
  expect(postBodies[0]).toContain(SNAPSHOT_ADDRESS);
  expect(postBodies[0]).toContain('"claimData"');
  expect(thirdPartyRequests).toEqual([]);
});

test('rejects uncompressed WIF before building a claim', async ({ page }) => {
  const postBodies: string[] = [];
  await mockClaimApi(page, postBodies);

  await page.goto('/#/claim', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('BTC snapshot address key').fill(SNAPSHOT_ADDRESS);
  await page.getByRole('button', { name: 'Check Eligibility' }).click();
  await expect(page.locator('span').filter({ hasText: /^Eligible$/ }).first()).toBeVisible();

  await page.getByLabel('BTC private key or seed phrase').fill(UNCOMPRESSED_WIF_LIKE);
  await page.getByRole('button', { name: 'Build Signed Claim' }).click();

  await expect(page.getByText('Uncompressed WIF keys are not supported')).toBeVisible();
  expect(postBodies).toHaveLength(0);
});
