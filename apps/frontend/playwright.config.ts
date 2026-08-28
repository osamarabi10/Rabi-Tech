import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8081',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx next start -H 127.0.0.1 -p 8081',
    url: 'http://127.0.0.1:8081/login',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
