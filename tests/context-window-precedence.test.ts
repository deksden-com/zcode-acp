/**
 * Context-gauge `size` precedence regression tests.
 *
 * The CLI's projection seeds `contextWindow` with a hardcoded 200K default
 * (bundle-verified: the initial reducer state carries `contextWindow: 2e5`)
 * and account-provider models carry no registry metadata, so backend events
 * during a turn advertise the placeholder. The user's config.json
 * `limit.context` is the explicit per-model truth and must WIN — before this
 * fix, the gauge flip-flopped: 1M at boot/model-switch (config-filled) but
 * 200K during turns (backend event value passed through nonzero).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { dispatchEvent } from "../src/handlers/dispatch.js";
import { emitInitialUsage, currentModelCached } from "../src/config/model-cache.js";
import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeBackend } from "../src/backend/client.js";

const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "GLM Coding Plan",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://example.test/api", apiKey: "plan-token" },
      models: {
        "GLM-5.3": { limit: { context: 1000000 } },
      },
    },
    "custom:other": {
      name: "Other",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://other.test/api", apiKey: "k" },
      // No models entry → modelContextWindow() returns 0 → backend fallback.
    },
  },
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(FAKE_CONFIG);
      return actual.readFileSync(p);
    },
  };
});

interface Update {
  sessionId: string;
  update: Record<string, unknown>;
}

function collectCx(): { cx: acp.AgentContext; updates: Update[] } {
  const updates: Update[] = [];
  const cx = {
    notify: async (_method: string, params: Record<string, unknown>) => {
      updates.push(params as unknown as Update);
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

/**
 * Fake backend answering session/read with a placeholder 200K projection and
 * (when configured) the session's current model in settings.
 */
function fakeBackend(settings: Record<string, unknown> = {}): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      if (method === "session/read") {
        return {
          result: {
            projection: { contextUsed: 46000, totalTokenCount: 46000, contextWindow: 200000 },
            settings,
          },
        };
      }
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

function setup(settings: Record<string, unknown>): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = fakeBackend(settings);
  server.registerSession("sess_cw", "zs_cw");
  server.markBackendLoaded("sess_cw");
  return server;
}

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("usage_update size precedence (config limit beats backend placeholder)", () => {
  it("a UsageDelta carrying the backend 200K placeholder emits the configured 1M", async () => {
    const server = setup({
      model: {
        current: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" },
      },
    });
    // Prime the model cache the way a real turn would (session/read).
    await currentModelCached(server, "zs_cw");
    const { cx, updates } = collectCx();
    await dispatchEvent(server, cx, "sess_cw", { kind: "UsageDelta", used: 46000, size: 200000 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 1000000,
    });
  });

  it("falls back to the backend value when config.json has no limit for the model", async () => {
    const server = setup({
      model: { current: { providerId: "custom:other", modelId: "mystery-model" } },
    });
    await currentModelCached(server, "zs_cw");
    const { cx, updates } = collectCx();
    await dispatchEvent(server, cx, "sess_cw", { kind: "UsageDelta", used: 1000, size: 200000 });
    expect(updates[0]!.update).toEqual({ sessionUpdate: "usage_update", used: 1000, size: 200000 });
  });

  it("emitInitialUsage uses the configured window over the projection's placeholder", async () => {
    const server = setup({
      model: {
        current: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" },
      },
    });
    const { cx, updates } = collectCx();
    await emitInitialUsage(server, cx, "sess_cw", "zs_cw", undefined);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update).toEqual({
      sessionUpdate: "usage_update",
      used: 46000,
      size: 1000000,
    });
  });
});
