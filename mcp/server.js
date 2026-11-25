#!/usr/bin/env node

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(major) || major < 18) {
  console.error(`mo3ta-coverage-mcp requires Node.js 18 or newer. This process is Node ${process.versions.node}.`);
  process.exit(1);
}

const { createServer } = await import('./createServer.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { readFileSync } = await import('node:fs');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = createServer({ version: pkg.version });

// stdout is the MCP JSON-RPC stream. Diagnostics stay on stderr.
console.error(`mo3ta-coverage MCP server ${pkg.version} listening on stdio`);
await server.connect(new StdioServerTransport());
