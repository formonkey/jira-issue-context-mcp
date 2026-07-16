import dotenv from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({
  path: [resolve(process.cwd(), ".env"), resolve(__dirname, "..", ".env")],
  quiet: true,
});

export interface Config {
  jiraBaseUrl: string;
  auth: AuthConfig;
  issueKey?: string;
  maxImageMB: number;
  requestTimeoutMs: number;
}

export type AuthConfig =
  | {
      mode: "basic";
      email: string;
      apiToken: string;
    }
  | {
      mode: "bearer";
      token: string;
    }
  | {
      mode: "cookie";
      cookieName: string;
      sessionToken: string;
    };

function getArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function getNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): Config {
  const jiraBaseUrl = getArgValue("base-url") || process.env.JIRA_BASE_URL || "";

  return {
    jiraBaseUrl,
    auth: loadAuthConfig(),
    issueKey: normalizeIssueKey(getArgValue("issue") || process.env.JIRA_ISSUE_KEY),
    maxImageMB: getNumber(process.env.JIRA_MAX_IMAGE_MB, 8),
    requestTimeoutMs: getNumber(process.env.JIRA_REQUEST_TIMEOUT_MS, 30000),
  };
}

function loadAuthConfig(): AuthConfig {
  const email = getArgValue("email") || process.env.JIRA_EMAIL;
  const apiToken = getArgValue("api-token") || process.env.JIRA_API_TOKEN;
  if (email && apiToken) {
    return {
      mode: "basic",
      email,
      apiToken,
    };
  }

  const bearerToken = getArgValue("bearer-token") || process.env.JIRA_BEARER_TOKEN;
  if (bearerToken) {
    return {
      mode: "bearer",
      token: bearerToken,
    };
  }

  const sessionToken = getArgValue("token") || process.env.JIRA_SESSION_TOKEN;
  if (sessionToken) {
    return {
      mode: "cookie",
      cookieName: getArgValue("cookie-name") || process.env.JIRA_COOKIE_NAME || "tenant.session.token",
      sessionToken,
    };
  }

  throw new Error(
    "No Jira auth configured. Set JIRA_EMAIL + JIRA_API_TOKEN, JIRA_BEARER_TOKEN, or JIRA_SESSION_TOKEN."
  );
}

export function normalizeIssueKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

export function assertIssueKey(value: string | undefined): string {
  const issueKey = normalizeIssueKey(value);
  if (!issueKey) {
    throw new Error(
      "No issue key provided. Set JIRA_ISSUE_KEY, start with --issue=KEY, or pass issueKey to the tool."
    );
  }
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) {
    throw new Error(`Invalid Jira issue key: ${issueKey}`);
  }
  return issueKey;
}
