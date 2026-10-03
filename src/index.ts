#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as ynab from "ynab";

import { accessPolicy } from "./accessPolicy.js";
import { FileCategoryAuditStore } from "./audit/fileCategoryAudit.js";
import { registerAll } from "./registry.js";

const server = new McpServer({
  name: "ynab-mcp-server",
  version: "0.4.0",
});

// Initialize YNAB API
const api = new ynab.API(process.env.YNAB_API_TOKEN || "");

registerAll(server, api, {
  ...accessPolicy(process.env),
  categoryAudit: process.env.YNAB_CATEGORY_AUDIT_DIR
    ? new FileCategoryAuditStore(process.env.YNAB_CATEGORY_AUDIT_DIR) : undefined,
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("YNAB MCP server running on stdio");
}

main().catch(console.error);
