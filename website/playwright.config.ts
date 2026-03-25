import { defineConfig, devices } from '@playwright/test';

const TAILWIND_VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  sm: { width: 640, height: 900 },
  md: { width: 768, height: 1024 },
  lg: { width: 1024, height: 768 },
  xl: { width: 1280, height: 800 },
  '2xl': { width: 1536, height: 864 },
};

export default defineConfig({
  testDir: './e2e',
  outputDir: './tmp/test-results',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:4173',
    screenshot: 'off',
    trace: 'off',
  },

  projects: Object.entries(TAILWIND_VIEWPORTS).map(([name, viewport]) => ({
    name,
    use: { ...devices['Desktop Chrome'], viewport },
  })),

  webServer: {
    command: 'pnpm run build && pnpm run preview',
    port: 4173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
