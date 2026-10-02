// The real tool schemas (generated snapshot of `qloo mcp` tools/list), read as plain data so the fake MCP server
// does not need a TypeScript loader. The snapshot is emitted with JSON.stringify, so the array literal is valid JSON.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../../src/qloo/fixtures/tools.snapshot.ts", import.meta.url));
const text = readFileSync(file, "utf8");
const start = text.indexOf("= [", text.indexOf("export const TOOLS_SNAPSHOT:")) + 2;
const end = text.lastIndexOf("]");
export const TOOLS_SNAPSHOT = JSON.parse(text.slice(start, end + 1));
