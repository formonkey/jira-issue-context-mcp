import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertIssueKey, Config, loadConfig } from "./config.js";
import { JiraAttachment, JiraClient } from "./jira-client.js";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

let config: Config;
try {
  config = loadConfig();
  if (!config.jiraBaseUrl) {
    throw new Error("No JIRA_BASE_URL configured.");
  }
} catch (error) {
  console.error(`ERROR: ${(error as Error).message}`);
  process.exit(1);
}

const jira = new JiraClient(config);

const server = new McpServer(
  {
    name: "codex-jira-issue-context",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "Read-only Jira MCP focused on one issue at a time. When the user prompt contains a Jira key such as CORE-7584 or PROJ-123, pass it to jira_issue_context as issueKey. Fetch title, description, comments, attachment summary, and image attachments. Do not use this server for board, sprint, search, or write operations.",
  }
);

server.registerTool(
  "jira_issue_context",
  {
    title: "Contexto de una issue Jira",
    description:
      "Devuelve contexto read-only de una issue concreta: titulo, descripcion, comentarios y adjuntos de imagen. Cuando el usuario escriba una clave Jira en el chat, pasala como issueKey.",
    inputSchema: {
      issueKey: z
        .string()
        .optional()
        .describe("Clave de Jira. Opcional si el MCP se arranco con --issue=KEY o JIRA_ISSUE_KEY."),
      includeComments: z
        .boolean()
        .optional()
        .describe("Incluye todos los comentarios paginados. Por defecto true."),
      includeImages: z
        .boolean()
        .optional()
        .describe("Descarga adjuntos de imagen y los devuelve como contenido MCP image. Por defecto true."),
      maxImageSizeMB: z
        .number()
        .optional()
        .describe("Limite por imagen en MB. Por defecto JIRA_MAX_IMAGE_MB o 8."),
    },
  },
  async (args) => {
    try {
      const issueKey = assertIssueKey(args.issueKey || config.issueKey);
      const includeComments = args.includeComments ?? true;
      const includeImages = args.includeImages ?? true;
      const maxImageSizeMB = args.maxImageSizeMB ?? config.maxImageMB;

      const issue = await jira.getIssue(issueKey);
      const comments = includeComments ? await jira.getAllComments(issueKey) : [];
      const attachments = issue.fields.attachment || [];

      const imageResult = includeImages
        ? await jira.downloadImages(attachments, maxImageSizeMB)
        : { downloaded: [], skipped: [] };

      const markdown = buildIssueMarkdown({
        issue,
        issueUrl: jira.issueUrl(issueKey),
        description: jira.adfToText(issue.fields.description).trim(),
        comments: comments.map((comment) => ({
          author: comment.author.displayName,
          created: comment.created,
          updated: comment.updated,
          body: jira.commentToText(comment),
        })),
        attachments,
        downloadedImages: imageResult.downloaded.map((item) => ({
          filename: item.attachment.filename,
          mimeType: item.contentType,
          size: item.downloadedSize,
        })),
        skippedImages: imageResult.skipped.map((item) => ({
          filename: item.attachment.filename,
          reason: item.reason,
        })),
      });

      const content: ToolContent[] = [{ type: "text", text: markdown }];

      for (const image of imageResult.downloaded) {
        content.push({
          type: "image",
          data: image.base64,
          mimeType: image.contentType,
        });
      }

      return { content };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error retrieving Jira issue context: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

interface BuildMarkdownInput {
  issue: Awaited<ReturnType<JiraClient["getIssue"]>>;
  issueUrl: string;
  description: string;
  comments: Array<{
    author: string;
    created: string;
    updated: string;
    body: string;
  }>;
  attachments: JiraAttachment[];
  downloadedImages: Array<{
    filename: string;
    mimeType: string;
    size: number;
  }>;
  skippedImages: Array<{
    filename: string;
    reason: string;
  }>;
}

function buildIssueMarkdown(input: BuildMarkdownInput): string {
  const { issue, issueUrl } = input;
  const fields = issue.fields;
  const lines: string[] = [];

  lines.push(`# ${issue.key}: ${fields.summary}`);
  lines.push("");
  lines.push(`- URL: ${issueUrl}`);
  lines.push(`- Type: ${fields.issuetype.name}`);
  lines.push(`- Status: ${fields.status.name}`);
  lines.push(`- Priority: ${fields.priority?.name || "None"}`);
  lines.push(`- Assignee: ${fields.assignee?.displayName || "Unassigned"}`);
  lines.push(`- Reporter: ${fields.reporter?.displayName || "Unknown"}`);
  lines.push(`- Created: ${fields.created}`);
  lines.push(`- Updated: ${fields.updated}`);

  if (fields.labels && fields.labels.length > 0) {
    lines.push(`- Labels: ${fields.labels.join(", ")}`);
  }

  if (fields.parent) {
    lines.push(`- Parent: ${fields.parent.key} - ${fields.parent.fields.summary}`);
  }

  lines.push("");
  lines.push("## Description");
  lines.push(input.description || "_No description._");

  lines.push("");
  lines.push(`## Comments (${input.comments.length})`);
  if (input.comments.length === 0) {
    lines.push("_No comments._");
  } else {
    input.comments.forEach((comment, index) => {
      lines.push("");
      lines.push(`### Comment ${index + 1} - ${comment.author} - ${comment.created}`);
      if (comment.updated && comment.updated !== comment.created) {
        lines.push(`_Updated: ${comment.updated}_`);
      }
      lines.push(comment.body || "_Empty comment._");
    });
  }

  lines.push("");
  lines.push(`## Attachments (${input.attachments.length})`);
  if (input.attachments.length === 0) {
    lines.push("_No attachments._");
  } else {
    for (const attachment of input.attachments) {
      lines.push(
        `- ${attachment.filename} (${attachment.mimeType}, ${formatBytes(attachment.size)}, ${attachment.created}, ${attachment.author.displayName})`
      );
    }
  }

  lines.push("");
  lines.push(`## Images Returned (${input.downloadedImages.length})`);
  if (input.downloadedImages.length === 0) {
    lines.push("_No image attachments returned._");
  } else {
    for (const image of input.downloadedImages) {
      lines.push(`- ${image.filename} (${image.mimeType}, ${formatBytes(image.size)})`);
    }
  }

  if (input.skippedImages.length > 0) {
    lines.push("");
    lines.push("## Images Skipped");
    for (const skipped of input.skippedImages) {
      lines.push(`- ${skipped.filename}: ${skipped.reason}`);
    }
  }

  return lines.join("\n");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jira issue MCP running on stdio");
  console.error(`Jira base URL: ${config.jiraBaseUrl}`);
  console.error(`Configured issue: ${config.issueKey || "(none)"}`);
}
