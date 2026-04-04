#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { runDoctorChecks } from "./doctor.js";

if (process.argv[2] === "doctor") {
  const result = await runDoctorChecks();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ready ? 0 : 1);
}

const server = new McpServer({
  name: "linkedin-post-agent",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
    resources: {},
  },
});

registerTools(server);
registerResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
