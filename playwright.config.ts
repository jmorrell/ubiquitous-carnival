import { defineConfig } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The installed package and cached Chromium revisions differ on this offline machine.
const cache = join(homedir(), "Library/Caches/ms-playwright");
const cached = existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()
  .map((name) => join(cache, name, "chrome-headless-shell-mac-arm64/chrome-headless-shell")).find(existsSync) : undefined;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? cached;

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173", headless: true, launchOptions: { executablePath } },
  webServer: {
    command: "npm run demo",
    url: "http://127.0.0.1:4173/api/context",
    timeout: 120_000,
    reuseExistingServer: false,
    env: { DEMO_STORE: mkdtempSync(join(tmpdir(), "magpie-browser-")) },
  },
});
