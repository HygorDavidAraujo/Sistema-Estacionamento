import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './test', testMatch: 'browser.spec.js', workers: 1,
    globalTeardown: './test/teardown.js',
    timeout: 60000, reporter: 'list',
    expect: { timeout: 10000 },
    use: { baseURL: 'http://127.0.0.1:3108', channel: 'msedge', headless: true,
        viewport: { width: 1366, height: 900 }, launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } },
    webServer: { command: 'node test/preview-server.js', url: 'http://127.0.0.1:3108/health', reuseExistingServer: false }
});
