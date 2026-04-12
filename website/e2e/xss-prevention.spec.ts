import { test, expect, Page } from '@playwright/test';

/**
 * XSS prevention tests: user-controlled URL parameters (block hash, tx ID,
 * address) are embedded in innerHTML. These tests verify that HTML special
 * characters are escaped before injection, so crafted payloads never execute
 * or render as markup.
 *
 * We set location.hash via page.evaluate (not page.goto) so the raw characters
 * are not percent-encoded by the browser before reaching the router.
 */

/** Return 404 for all block/tx lookups so error views are triggered */
async function mockApiNotFound(page: Page): Promise<void> {
  await page.route('**/api/v1/**', (route) => {
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

/** Return a minimal valid status so the page initialises, 404 for everything else */
async function mockApiWithStatus(page: Page): Promise<void> {
  const status = {
    name: 'qubitcoin', height: 1, mempoolSize: 0, utxoCount: 0,
    difficulty: '0000ffff', lastBlockTime: Date.now(), targetBlockTime: 1800000,
    peers: 0, avgBlockTime: 1800000, blockReward: 312500000, totalTxs: 0,
    hashrate: 0,
  };
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/status') {
      return route.fulfill({ json: status });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
}

/** Set location.hash directly so raw characters are not percent-encoded */
async function setHash(page: Page, hash: string, waitFor = '#explorer-content p.text-red-500'): Promise<void> {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector(waitFor, { state: 'visible' });
}

test.describe('XSS prevention — block error view', () => {
  test('img onerror in block hash does not execute', async ({ page }) => {
    await mockApiNotFound(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/block/<img src=x onerror="window.__xss_block=1">');

    const xssExecuted = await page.evaluate(() => (window as any).__xss_block);
    expect(xssExecuted).toBeUndefined();
  });

  test('angle brackets in block hash are escaped as text in error message', async ({ page }) => {
    await mockApiNotFound(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/block/<img src=x onerror="window.__xss_block2=1">');

    const errorEl = page.locator('#explorer-content p.text-red-500');
    await expect(errorEl).toBeVisible();

    // The raw <img should NOT be an actual element inside the error paragraph
    const imgInside = await errorEl.locator('img').count();
    expect(imgInside).toBe(0);

    // The innerHTML must not contain an unescaped <img tag (literal or injected)
    const innerHTML = await page.evaluate(() =>
      document.querySelector('#explorer-content p.text-red-500')?.innerHTML ?? ''
    );
    expect(innerHTML).not.toContain('<img');
  });

  test('double-quote in block hash cannot break out of attribute context', async ({ page }) => {
    await mockApiNotFound(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/block/abc" onclick="window.__xss_attr=1"');

    const errorEl = page.locator('#explorer-content p.text-red-500');
    await expect(errorEl).toBeVisible();

    // The raw quote should be HTML-escaped, not present as a real attribute
    const innerHTML = await page.evaluate(() =>
      document.querySelector('#explorer-content p.text-red-500')?.innerHTML ?? ''
    );
    expect(innerHTML).not.toContain('" onclick=');
  });
});

test.describe('XSS prevention — transaction error view', () => {
  test('img onerror in tx ID does not execute', async ({ page }) => {
    await mockApiNotFound(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/tx/<img src=x onerror="window.__xss_tx=1">');

    const xssExecuted = await page.evaluate(() => (window as any).__xss_tx);
    expect(xssExecuted).toBeUndefined();
  });

  test('angle brackets in tx ID are escaped as text in error message', async ({ page }) => {
    await mockApiNotFound(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/tx/<img src=x onerror="window.__xss_tx2=1">');

    const errorEl = page.locator('#explorer-content p.text-red-500');
    await expect(errorEl).toBeVisible();

    const imgInside = await errorEl.locator('img').count();
    expect(imgInside).toBe(0);

    const innerHTML = await page.evaluate(() =>
      document.querySelector('#explorer-content p.text-red-500')?.innerHTML ?? ''
    );
    expect(innerHTML).not.toContain('<img');
  });
});

test.describe('XSS prevention — address view', () => {
  test('img onerror in address does not execute', async ({ page }) => {
    await mockApiWithStatus(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/address/<img src=x onerror="window.__xss_addr=1">', '#explorer-content p.font-mono.break-all');

    const xssExecuted = await page.evaluate(() => (window as any).__xss_addr);
    expect(xssExecuted).toBeUndefined();
  });

  test('angle brackets in address are HTML-escaped in address card', async ({ page }) => {
    await mockApiWithStatus(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/address/<img src=x onerror="window.__xss_addr2=1">', '#explorer-content p.font-mono.break-all');

    const addrEl = page.locator('#explorer-content p.font-mono.break-all').first();
    await expect(addrEl).toBeVisible();

    // No actual <img> elements should exist inside the address paragraph
    const imgInside = await addrEl.locator('img').count();
    expect(imgInside).toBe(0);

    // innerHTML must not contain a live <img> tag (raw or unescaped)
    const innerHTML = await page.evaluate(() =>
      document.querySelector('#explorer-content p.font-mono.break-all')?.innerHTML ?? ''
    );
    expect(innerHTML).not.toContain('<img');
  });

  test('double-quote in address does not break out of HTML context', async ({ page }) => {
    await mockApiWithStatus(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await setHash(page, '#/address/abc" onclick="window.__xss_addr_attr=1"', '#explorer-content p.font-mono.break-all');

    const addrEl = page.locator('#explorer-content p.font-mono.break-all').first();
    await expect(addrEl).toBeVisible();

    const innerHTML = await page.evaluate(() =>
      document.querySelector('#explorer-content p.font-mono.break-all')?.innerHTML ?? ''
    );
    expect(innerHTML).not.toContain('" onclick=');
  });
});
