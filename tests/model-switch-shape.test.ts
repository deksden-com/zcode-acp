/**
 * session/setModel wire-shape contract against the open-sourced 0.16.9 schema.
 *
 * `zcodeSessionSetModelParamsSchema` is STRICT and `model` must be the
 * modelSelectionSchema OBJECT (zcode-protocol/index.ts:1952-1959;
 * model-selection.ts:4-15): no `runtimeModel` key, no string form. The bridge
 * used to retry a failed switch once with the legacy `{model, runtimeModel}`
 * overlay — dead code on this build (a guaranteed second rejection, observed
 * in logs as a confusing double error), removed 2026-09-21. A switch carries
 * the modern shape on EVERY attempt; extra attempts exist only for the
 * reasoning-level ladder (see the level-ladder describe below).
 */

import { describe, expect, it } from "vitest";

import { applyModelSwitch } from "../src/config/runtime-model.js";
import { ZcodeAcpServer } from "../src/server.js";

const SID_Z = "zc-switch-1";
/** Encoded `providerId\modelId` value (parseModelValue's new-format spelling). */
const VALUE = "builtin:bigmodel-coding-plan\\GLM-5";

function boot(responder: (method: string) => unknown) {
  const server = new ZcodeAcpServer();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  server.backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return responder(method);
    },
  } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
  return { server, calls };
}

describe("applyModelSwitch wire shape (0.16.9)", () => {
  it("sends exactly one strict-shape request, no runtimeModel retry", async () => {
    const { server, calls } = boot(() => ({ result: {} }));
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(true);
    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(1);
    expect(setModels[0]!.params).not.toHaveProperty("runtimeModel");
    expect(setModels[0]!.params).toEqual({
      sessionId: SID_Z,
      model: { providerId: expect.any(String), modelId: "GLM-5" },
      persistAsWorkspaceLastUsed: false,
    });
  });

  it("does NOT retry with the legacy overlay when the modern shape is rejected", async () => {
    const { server, calls } = boot(() => ({
      error: { message: "Unrecognized key: runtimeModel" },
    }));
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(1);
  });

  it("carries the target's default reasoning level when the availability cache knows it", async () => {
    // Learn the registry spelling first: the bridge translates config.json's
    // `builtin:*` id through the builtin provider table when one is present
    // (accountProviderIdFor), and the cache is keyed by the translated id.
    const probe = boot(() => ({ result: {} }));
    await applyModelSwitch(probe.server, SID_Z, VALUE);
    const registryId = (probe.calls[0]!.params["model"] as { providerId: string }).providerId;
    const { server, calls } = boot(() => ({ result: {} }));
    server.modelAvailability.set(SID_Z, [
      { providerId: registryId, modelId: "GLM-5", defaultLevel: "high" },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(true);
    const model = calls[0]!.params["model"] as { options?: { reasoningLevel?: string } };
    expect(model.options?.reasoningLevel).toBe("high");
  });
});

describe("applyModelSwitch level ladder (stale-local-file recovery)", () => {
  /** Answer session/setModel from a scripted per-attempt sequence. */
  function bootScripted(responses: Array<Record<string, unknown> | undefined>) {
    let attempt = 0;
    const { server, calls } = boot(() =>
      attempt < responses.length ? (responses[attempt++] ?? { result: {} }) : { result: {} },
    );
    return { server, calls };
  }
  const registryProbe = async (): Promise<string> => {
    const probe = boot(() => ({ result: {} }));
    await applyModelSwitch(probe.server, SID_Z, VALUE);
    return (probe.calls[0]!.params["model"] as { providerId: string }).providerId;
  };
  const levelOf = (params: Record<string, unknown>): string | undefined =>
    ((params["model"] as { options?: { reasoningLevel?: string } })?.options ?? {}).reasoningLevel;

  it("falls back to omission when the resolved level is rejected by the registry", async () => {
    const registryId = await registryProbe();
    // config.json/personal files are absent in the hermetic HOME — the stale
    // "max" comes from the captured snapshot, standing in for any stale source.
    const { server, calls } = bootScripted([
      { error: { message: 'Reasoning effort "max" is not supported by p/GLM-5' } },
      { result: {} },
    ]);
    server.modelAvailability.set(SID_Z, [
      { providerId: registryId, modelId: "GLM-5", defaultLevel: "max", levels: ["max"] },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(true);
    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(2);
    expect(levelOf(setModels[0]!.params)).toBe("max");
    expect(levelOf(setModels[1]!.params)).toBeUndefined();
  });

  it("falls back to the next candidate when omission hits a level-required def", async () => {
    const registryId = await registryProbe();
    const { server, calls } = bootScripted([
      { error: { message: 'Reasoning effort "max" is not supported by p/GLM-5' } },
      { error: { message: "Reasoning level is required for p/GLM-5" } },
      { result: {} },
    ]);
    server.modelAvailability.set(SID_Z, [
      { providerId: registryId, modelId: "GLM-5", defaultLevel: "max", levels: ["max", "high"] },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(true);
    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(3);
    expect(levelOf(setModels[2]!.params)).toBe("high");
  });

  it("a snapshot hit declaring NO levels sends a single level-less request", async () => {
    const registryId = await registryProbe();
    // Even though no local files exist here, this pins the contract that a
    // level-less snapshot verdict suppresses file-derived candidates in
    // candidateReasoningLevels (the backend already said: no levels).
    const { server, calls } = bootScripted([{ result: {} }]);
    server.modelAvailability.set(SID_Z, [
      { providerId: registryId, modelId: "GLM-5", defaultLevel: undefined, levels: [] },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(true);
    const setModels = calls.filter((c) => c.method === "session/setModel");
    expect(setModels).toHaveLength(1);
    expect(levelOf(setModels[0]!.params)).toBeUndefined();
  });

  it("level-unrelated errors abort the ladder without retries", async () => {
    const registryId = await registryProbe();
    const { server, calls } = bootScripted([
      { error: { message: "Provider Registry 中不存在 Model: p/GLM-5" } },
    ]);
    server.modelAvailability.set(SID_Z, [
      { providerId: registryId, modelId: "GLM-5", defaultLevel: "high" },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(1);
  });

  it("reports the last error when every attempt is rejected", async () => {
    const registryId = await registryProbe();
    const { server, calls } = bootScripted([
      { error: { message: 'Reasoning effort "max" is not supported by p/GLM-5' } },
      { error: { message: "Reasoning level is required for p/GLM-5" } },
    ]);
    server.modelAvailability.set(SID_Z, [
      { providerId: registryId, modelId: "GLM-5", defaultLevel: "max", levels: ["max"] },
    ]);
    const ok = await applyModelSwitch(server, SID_Z, VALUE);
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "session/setModel")).toHaveLength(2);
  });
});
