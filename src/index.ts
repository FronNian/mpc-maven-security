#!/usr/bin/env node
/**
 * MCP-MAVEN-SECURITY
 * MCP tool for scanning Maven project dependency vulnerabilities
 */

import { McpServer } from './mcp/server.js';

async function main(): Promise<void> {
  const server = new McpServer();
  await server.start();
}

main().catch((error: unknown) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
