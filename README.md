# jira-issue-context-mcp

Read-only MCP server that gives Codex, Claude, Cursor, or any MCP client the context for a specific Jira issue.

It intentionally does one thing: fetch a single issue by key and return the issue title, description, comments, attachment summary, and image attachments.

## Features

- Single read-only tool: `jira_issue_context`
- No board listing, sprint browsing, JQL search, transitions, comments, or writes
- Converts Jira ADF descriptions/comments into plain Markdown-ish text
- Paginates all issue comments
- Returns image attachments as MCP `image` content
- Supports Atlassian Cloud API token auth, bearer auth, or browser/session cookie auth
- Optional Playwright login helper for cookie-based SSO setups

## Install

```bash
npm install
npm run build
```

## Authentication

Set `JIRA_BASE_URL` plus one auth method.

You can put these variables in the shell environment or in a `.env` file in the directory where the MCP command is started. The package also checks its own local `.env` as a fallback.

Recommended for Atlassian Cloud:

```env
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-atlassian-api-token
```

Bearer token:

```env
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_BEARER_TOKEN=your-token
```

Cookie/session token:

```env
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_SESSION_TOKEN=your-cookie-value
JIRA_COOKIE_NAME=tenant.session.token
```

For SSO environments where API tokens are not available, the login helper can capture a browser cookie:

```bash
npx -y --package github:formonkey/jira-issue-context-mcp#main jira-issue-login \
  --base-url=https://your-domain.atlassian.net \
  --cookie-name=tenant.session.token \
  --browser-channel=msedge
```

Run it from your project root. The login helper writes `JIRA_SESSION_TOKEN` to `.env` in the current directory and uses a persistent Playwright profile at `.auth/browser-profile` by default. `--browser-channel=msedge` uses your installed Edge instead of downloading Playwright's Chromium. You may need to complete SSO/MFA manually the first time; later runs reuse the browser session while it remains valid.

If Microsoft SSO blocks the automated browser, start Edge yourself with remote debugging and let the helper connect to that real Edge session:

```bash
npx -y --package github:formonkey/jira-issue-context-mcp#main jira-issue-login \
  --base-url=https://your-domain.atlassian.net \
  --cookie-name=tenant.session.token \
  --launch-browser=msedge \
  --cdp-port=9222 \
  --default-profile=true
```

This launches a real Edge process with the installed browser's default profile, connects to it over CDP, waits for you to finish Microsoft SSO, captures the Jira session cookie, and writes it to `.env`.

Advanced manual mode:

```powershell
start msedge --remote-debugging-port=9222
```

Then run:

```bash
npx -y --package github:formonkey/jira-issue-context-mcp#main jira-issue-login \
  --base-url=https://your-domain.atlassian.net \
  --cookie-name=tenant.session.token \
  --cdp-url=http://127.0.0.1:9222
```

Both CDP modes are useful for corporate SSO because the browser is launched as a normal installed browser instead of a Playwright-managed browser.

## Codex Project Config

Example `.codex/config.toml`:

```toml
[mcp_servers.jira_issue]
command = "node"
args = ["/absolute/path/to/jira-issue-context-mcp/dist/index.js"]
cwd = "/absolute/path/to/jira-issue-context-mcp"
env_vars = [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_BEARER_TOKEN",
  "JIRA_SESSION_TOKEN",
  "JIRA_COOKIE_NAME",
  "JIRA_MAX_IMAGE_MB"
]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 90
default_tools_approval_mode = "auto"
```

Then ask your agent:

```text
JIRA CORE-7584: read the issue context and prepare an implementation plan.
```

The agent should call:

```json
{ "issueKey": "CORE-7584" }
```

## Tool

### `jira_issue_context`

Parameters:

- `issueKey` required in normal chat-driven usage, e.g. `CORE-7584`
- `includeComments` optional, defaults to `true`
- `includeImages` optional, defaults to `true`
- `maxImageSizeMB` optional, defaults to `JIRA_MAX_IMAGE_MB` or `8`

The server also supports `--issue=KEY` or `JIRA_ISSUE_KEY` as fallback defaults, but passing the issue key from chat is usually cleaner.
