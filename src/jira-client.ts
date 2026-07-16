import { AuthenticatedConfig } from "./config.js";

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string;
  author: JiraUser;
  content: string;
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body: unknown;
  renderedBody?: string;
  created: string;
  updated: string;
}

export interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string; statusCategory?: { name: string } };
    priority?: { name: string };
    issuetype: { name: string; subtask: boolean };
    assignee?: JiraUser;
    reporter?: JiraUser;
    labels?: string[];
    created: string;
    updated: string;
    parent?: {
      key: string;
      fields: {
        summary: string;
        issuetype: { name: string };
      };
    };
    attachment?: JiraAttachment[];
  };
}

export interface DownloadedImage {
  attachment: JiraAttachment;
  contentType: string;
  base64: string;
  downloadedSize: number;
}

export interface SkippedImage {
  attachment: JiraAttachment;
  reason: string;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: AuthenticatedConfig) {
    this.baseUrl = config.jiraBaseUrl.replace(/\/+$/, "");
    this.authHeaders = this.createAuthHeaders(config);
    this.timeoutMs = config.requestTimeoutMs;
  }

  issueUrl(issueKey: string): string {
    return `${this.baseUrl}/browse/${issueKey}`;
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    const params = new URLSearchParams({
      expand: "renderedFields",
      fields:
        "summary,description,status,priority,issuetype,assignee,reporter,labels,created,updated,parent,attachment",
    });

    return this.request<JiraIssue>(`/rest/api/3/issue/${issueKey}?${params.toString()}`);
  }

  async getAllComments(issueKey: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const params = new URLSearchParams({
        expand: "renderedBody",
        startAt: String(startAt),
        maxResults: String(maxResults),
      });

      const page = await this.request<{
        comments: JiraComment[];
        startAt: number;
        maxResults: number;
        total: number;
      }>(`/rest/api/3/issue/${issueKey}/comment?${params.toString()}`);

      comments.push(...page.comments);

      if (comments.length >= page.total || page.comments.length === 0) {
        break;
      }
      startAt += page.comments.length;
    }

    return comments;
  }

  async downloadImages(
    attachments: JiraAttachment[],
    maxImageSizeMB: number
  ): Promise<{ downloaded: DownloadedImage[]; skipped: SkippedImage[] }> {
    const maxBytes = Math.max(1, maxImageSizeMB) * 1024 * 1024;
    const downloaded: DownloadedImage[] = [];
    const skipped: SkippedImage[] = [];

    for (const attachment of attachments.filter((item) => this.isImage(item))) {
      if (attachment.size > maxBytes) {
        skipped.push({
          attachment,
          reason: `image is ${attachment.size} bytes; limit is ${maxBytes} bytes`,
        });
        continue;
      }

      try {
        const { data, contentType } = await this.downloadAttachment(attachment.content);
        downloaded.push({
          attachment,
          contentType: contentType || attachment.mimeType,
          base64: Buffer.from(data).toString("base64"),
          downloadedSize: data.length,
        });
      } catch (error) {
        skipped.push({
          attachment,
          reason: (error as Error).message,
        });
      }
    }

    return { downloaded, skipped };
  }

  adfToText(adf: unknown): string {
    if (!adf || typeof adf !== "object") return String(adf ?? "");

    const node = adf as Record<string, unknown>;
    const type = node.type as string | undefined;
    const text = node.text as string | undefined;
    const content = node.content;
    const children = Array.isArray(content) ? content : [];

    if (type === "text") return text || "";

    if (type === "hardBreak") return "\n";

    if (type === "paragraph") {
      return `${children.map((child) => this.adfToText(child)).join("")}\n`;
    }

    if (type === "heading") {
      const attrs = node.attrs as { level?: number } | undefined;
      const level = Math.min(Math.max(attrs?.level || 2, 1), 6);
      return `${"#".repeat(level)} ${children.map((child) => this.adfToText(child)).join("")}\n`;
    }

    if (type === "bulletList" || type === "orderedList") {
      return `${children
        .map((item, index) => {
          const prefix = type === "orderedList" ? `${index + 1}. ` : "- ";
          return `${prefix}${this.adfToText(item).trim()}`;
        })
        .join("\n")}\n`;
    }

    if (type === "listItem") {
      return children.map((child) => this.adfToText(child)).join("").trim();
    }

    if (type === "codeBlock") {
      return `\`\`\`\n${children.map((child) => this.adfToText(child)).join("")}\n\`\`\`\n`;
    }

    if (type === "blockquote") {
      return children
        .map((child) =>
          this.adfToText(child)
            .split("\n")
            .filter(Boolean)
            .map((line) => `> ${line}`)
            .join("\n")
        )
        .join("\n");
    }

    if (type === "table") {
      return this.tableToText(children);
    }

    if (type === "inlineCard" || type === "blockCard") {
      const attrs = node.attrs as { url?: string } | undefined;
      return attrs?.url || "";
    }

    if (type === "mention") {
      const attrs = node.attrs as { text?: string } | undefined;
      return attrs?.text || "";
    }

    if (type === "media" || type === "mediaGroup" || type === "mediaSingle") {
      return "[media]\n";
    }

    return children.map((child) => this.adfToText(child)).join("");
  }

  commentToText(comment: JiraComment): string {
    return this.adfToText(comment.body).trim();
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...this.authHeaders,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Codex-Jira-Issue-MCP/1.0",
          ...(options.headers as Record<string, string> | undefined),
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Jira API error ${response.status} ${response.statusText} for ${url}: ${body.slice(0, 500)}`
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async downloadAttachment(
    url: string
  ): Promise<{ data: Uint8Array; contentType: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: {
          ...this.authHeaders,
          Accept: "*/*",
          "User-Agent": "Codex-Jira-Issue-MCP/1.0",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `attachment download failed ${response.status} ${response.statusText}: ${body.slice(0, 300)}`
        );
      }

      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type"),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private isImage(attachment: JiraAttachment): boolean {
    const mimeType = attachment.mimeType.toLowerCase();
    if (mimeType.startsWith("image/")) return true;

    const filename = attachment.filename.toLowerCase();
    return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].some((ext) =>
      filename.endsWith(ext)
    );
  }

  private tableToText(rows: unknown[]): string {
    return `${rows
      .map((row) => {
        const rowNode = row as { content?: unknown[] };
        const cells = rowNode.content || [];
        return `| ${cells
          .map((cell) => {
            const cellNode = cell as { content?: unknown[] };
            return (cellNode.content || [])
              .map((child) => this.adfToText(child))
              .join("")
              .trim()
              .replace(/\n+/g, " ");
          })
          .join(" | ")} |`;
      })
      .join("\n")}\n`;
  }

  private createAuthHeaders(config: AuthenticatedConfig): Record<string, string> {
    if (config.auth.mode === "basic") {
      const token = Buffer.from(`${config.auth.email}:${config.auth.apiToken}`, "utf-8").toString(
        "base64"
      );
      return { Authorization: `Basic ${token}` };
    }

    if (config.auth.mode === "bearer") {
      return { Authorization: `Bearer ${config.auth.token}` };
    }

    return { Cookie: `${config.auth.cookieName}=${config.auth.sessionToken}` };
  }
}
