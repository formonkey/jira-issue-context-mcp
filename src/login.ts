import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(PROJECT_ROOT, ".env");

function getArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readEnvValue(name: string): string | undefined {
  const value = process.env[name];
  if (value) return value;

  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const match = content.match(new RegExp(`^${name}=(.*)$`, "m"));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
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

  return isAbsolute(configured) ? configured : resolve(PROJECT_ROOT, configured);
}

export async function interactiveLogin(): Promise<string> {
  const jiraBaseUrl = readEnvValue("JIRA_BASE_URL");
  if (!jiraBaseUrl) {
    throw new Error("Set JIRA_BASE_URL before running the login helper.");
  }
  const cookieName = readEnvValue("JIRA_COOKIE_NAME") || "tenant.session.token";
  const profileDir = resolveProfileDir();

  console.log("Jira Issue MCP - interactive login");
  console.log(`Opening ${jiraBaseUrl}`);
  console.log(`Using persistent browser profile: ${profileDir}`);
  console.log(
    `Complete SSO in the browser window if required. The ${cookieName} cookie will be saved to .env.`
  );

  mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(jiraBaseUrl, { waitUntil: "domcontentloaded" });

  const maxWaitMs = 5 * 60 * 1000;
  const pollIntervalMs = 2000;
  let elapsed = 0;
  let token: string | undefined;

  while (elapsed < maxWaitMs) {
    const cookies = await context.cookies();
    token = cookies.find((cookie) => cookie.name === cookieName)?.value;
    if (token) break;

    await page.waitForTimeout(pollIntervalMs);
    elapsed += pollIntervalMs;
  }

  if (!token) {
    await context.close();
    throw new Error("Could not capture tenant.session.token after 5 minutes.");
  }

  console.log("Token captured. Verifying Jira REST API access...");
  await page.goto(`${jiraBaseUrl}/rest/api/3/myself`, { waitUntil: "domcontentloaded" });

  elapsed = 0;
  let verified = false;
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

  await context.close();

  if (!verified) {
    throw new Error("Token captured, but Jira REST API access could not be verified.");
  }

  updateEnvValue("JIRA_BASE_URL", jiraBaseUrl);
  updateEnvValue("JIRA_COOKIE_NAME", cookieName);
  updateEnvValue("JIRA_SESSION_TOKEN", token);

  console.log("Login successful. JIRA_SESSION_TOKEN saved to .env.");
  return token;
}
