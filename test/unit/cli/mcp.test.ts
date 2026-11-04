import { describe, expect, it } from "vitest";
import { MCP_PROTOCOL_VERSION } from "../../../src/server/mcp/rpc";
import { lib } from "./load";

const { MCP_VERSION } = await lib<{ MCP_VERSION: string }>("mcp");

describe("the CLI's MCP client", () => {
  it("speaks the revision the server speaks", () => {
    // A literal in bin/, because nothing there may import src/ (agent-cli.md ground truth).
    expect(MCP_VERSION).toBe(MCP_PROTOCOL_VERSION);
  });
});
