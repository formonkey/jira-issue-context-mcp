import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { platform } from "os";
import { dirname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const WORK_DIR = process.cwd();
const ENV_PATH = resolve(WORK_DIR, ".env");
const PACKAGE_ENV_PATH = resolve(PACKAGE_ROOT, ".env");

function getArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readEnvValue(name: string): string | undefined {
  const value = process.env[name];
  if (value) return value;

  for (const envPath of [ENV_PATH, PACKAGE_ENV_PATH]) {
    try {
      const content = readFileSync(envPath, "utf-8");
      const match = content.match(new RegExp(`^${name}=(.*)$`, "m"));
      if (match?.[1]?.trim()) return match[1].trim();
    } catch {
      // Try the next location.
    }
  }

  return undefined;
}

function updateEnvValue(name: string, value: string): void {
  let content = "";
  try {
    content = readFileSync(ENV_PATH, "utf-8");
  } catch {
    content = "";
  }

  const line = `${name}=${value}`;
  if (content.match(new RegExp(`^${name}=.*$`, "m"))) {
    content = content.replace(new RegExp(`^${name}=.*$`, "m"), line);
  } else {
    content = `${content.trimEnd()}\n${line}\n`;
  }

  writeFileSync(ENV_PATH, content, "utf-8");
}

function resolveProfileDir(): string {
  const configured =
    getArgValue("profile-dir") ||
    readEnvValue("JIRA_BROWSER_PROFILE_DIR") ||
    ".auth/browser-profile";

  return isAbsolute(configured) ? configured : resolve(WORK_DIR, configured);
}

function getCdpPort(cdpUrl?: string): string {
  const configured = getArgValue("cdp-port") || readEnvValue("JIRA_CDP_PORT");
  if (configured) return configured;

  if (cdpUrl) {
    try {
      return new URL(cdpUrl).port || "9222";
    } catch {
      return "9222";
    }
  }

  return "9222";
}

function resolveBrowserCommand(browserName: string): string {
  const normalized = browserName.toLowerCase();

  if (["edge", "msedge", "microsoft-edge"].includes(normalized)) {
    if (platform() === "win32") {
      const candidates = [
        process.env["PROGRAMFILES(X86)"],
        process.env.PROGRAMFILES,
        process.env.LOCALAPPDATA,
      ]
        .filter((basePath): basePath is string => Boolean(basePath))
        .map((basePath) => resolve(basePath, "Microsoft", "Edge", "Application", "msedge.exe"));

      return candidates.find((candidate) => existsSync(candidate)) ?? "msedge.exe";
    }

    if (platform() === "darwin") {
      const edgePath = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
      return existsSync(edgePath) ? edgePath : "microsoft-edge";
    }

    if (platform() === "linux") {
      return "microsoft-edge";
    }

    return "msedge";
  }

  if (["chrome", "google-chrome"].includes(normalized)) {
    if (platform() === "win32") {
      const candidates = [
        process.env.PROGRAMFILES,
        process.env["PROGRAMFILES(X86)"],
        process.env.LOCALAPPDATA,
      ]
        .filter((basePath): basePath is string => Boolean(basePath))
        .map((basePath) => resolve(basePath, "Google", "Chrome", "Application", "chrome.exe"));

      return candidates.find((candidate) => existsSync(candidate)) ?? "chrome.exe";
    }

    if (platform() === "darwin") {
      const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      return existsSync(chromePath) ? chromePath : "google-chrome";
    }

    if (platform() === "linux") {
      return "google-chrome";
    }

    return "chrome";
  }

  return browserName;
}

function launchExternalBrowser(browserName: string, cdpPort: string, jiraBaseUrl: string): void {
  const profileDir = resolveProfileDir();
  const command = resolveBrowserCommand(browserName);

  mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--new-window",
    jiraBaseUrl,
  ];

  console.log(`Launching ${browserName} with remote debugging on port ${cdpPort}`);
  console.log(`Browser executable: ${command}`);
  console.log(`Using persistent browser profile: ${profileDir}`);

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", (error) => {
    console.error(`Could not launch ${browserName}: ${error.message}`);
  });

  child.unref();
}

async function connectOverCdpWithRetry(cdpUrl: string, timeoutMs = 60_000): Promise<Browser> {
  const startedAt = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      lastError = error as Error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }

  throw new Error(`Could not connect to browser at ${cdpUrl}. ${lastError?.message || ""}`.trim());
}

type LoginSession = {
  context: BrowserContext;
  page: Page;
  cleanup: () => Promise<void>;
};

async function openLoginSession(jiraBaseUrl: string, browserChannel?: string): Promise<LoginSession> {
  const launchBrowser = getArgValue("launch-browser") || readEnvValue("JIRA_LAUNCH_BROWSER");
  const explicitCdpUrl = getArgValue("cdp-url") || readEnvValue("JIRA_CDP_URL");
  const cdpPort = getCdpPort(explicitCdpUrl);
  const cdpUrl = explicitCdpUrl || (launchBrowser ? `http://127.0.0.1:${cdpPort}` : undefined);

  if (launchBrowser) {
    launchExternalBrowser(launchBrowser, cdpPort, jiraBaseUrl);
  }

  if (cdpUrl) {
    console.log(`Connecting to existing browser over CDP: ${cdpUrl}`);

    let browser: Browser;
    try {
      browser = await connectOverCdpWithRetry(cdpUrl);
    } catch (error) {
      throw new Error(
        `Could not connect to browser at ${cdpUrl}. Start it with --remote-debugging-port first. ${
          (error as Error).message
        }`
      );
    }

    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    await page.bringToFront().catch(() => undefined);

    return {
      context,
      page,
      cleanup: async () => {
        await browser.close().catch(() => undefined);
      },
    };
  }

  const profileDir = resolveProfileDir();
  console.log(`Using persistent browser profile: ${profileDir}`);
  if (browserChannel) {
    console.log(`Using installed browser channel: ${browserChannel}`);
  }

  mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: browserChannel,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: null,
  });

  const page = await context.newPage();

  return {
    context,
    page,
    cleanup: async () => {
      await context.close().catch(() => undefined);
    },
  };
}

export async function interactiveLogin(): Promise<string> {
  const jiraBaseUrl = getArgValue("base-url") || readEnvValue("JIRA_BASE_URL");
  if (!jiraBaseUrl) {
    throw new Error("Set JIRA_BASE_URL before running the login helper.");
  }
  const cookieName = getArgValue("cookie-name") || readEnvValue("JIRA_COOKIE_NAME") || "tenant.session.token";
  const browserChannel = getArgValue("browser-channel") || readEnvValue("JIRA_BROWSER_CHANNEL");

  console.log("Jira Issue MCP - interactive login");
  console.log(`Opening ${jiraBaseUrl}`);
  console.log(`Writing token to: ${ENV_PATH}`);
  console.log(
    `Complete SSO in the browser window if required. The ${cookieName} cookie will be saved to .env.`
  );

  const { context, page, cleanup } = await openLoginSession(jiraBaseUrl, browserChannel);

  const maxWaitMs = 5 * 60 * 1000;
  const pollIntervalMs = 2000;
  let elapsed = 0;
  let token: string | undefined;
  let verified = false;

  try {
    await page.goto(jiraBaseUrl, { waitUntil: "domcontentloaded" });

    while (elapsed < maxWaitMs) {
      const cookies = await context.cookies();
      token = cookies.find((cookie) => cookie.name === cookieName)?.value;
      if (token) break;

      await page.waitForTimeout(pollIntervalMs);
      elapsed += pollIntervalMs;
    }

    if (!token) {
      throw new Error(`Could not capture ${cookieName} after 5 minutes.`);
    }

    console.log("Token captured. Verifying Jira REST API access...");
    await page.goto(`${jiraBaseUrl}/rest/api/3/myself`, { waitUntil: "domcontentloaded" });

    elapsed = 0;
    while (elapsed < maxWaitMs) {
      const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      if (body.trim().startsWith("{")) {
        JSON.parse(body);
        verified = true;
        break;
      }

      const url = page.url();
      if (url.includes("id.atlassian.com") || url.includes("step-up") || url.includes("login")) {
        console.log("Additional verification required. Complete it in the browser window...");
      }

      await page.waitForTimeout(pollIntervalMs);
      elapsed += pollIntervalMs;
    }

    const finalCookies = await context.cookies();
    token = finalCookies.find((cookie) => cookie.name === cookieName)?.value || token;
  } finally {
    await cleanup();
  }

  if (!verified) {
    throw new Error("Token captured, but Jira REST API access could not be verified.");
  }

  updateEnvValue("JIRA_BASE_URL", jiraBaseUrl);
  updateEnvValue("JIRA_COOKIE_NAME", cookieName);
  updateEnvValue("JIRA_SESSION_TOKEN", token);

  console.log("Login successful. JIRA_SESSION_TOKEN saved to .env.");
  return token;
}
