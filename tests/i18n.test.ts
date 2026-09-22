/**
 * i18n resolution tests: ZCODE_ACP_LANG override → ZCode app settings
 * (<zcode-home>/v2/setting.json, mocked fs — `~/.zcode` or `$ZCODE_HOME`) →
 * POSIX locale sniff → English default, plus table completeness (no empty
 * entry in either language).
 */

import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake settings-file content; null = file absent (ENOENT).
let settingJson: string | null = null;
// Fake user-config content (~/.config/zcode-acp/config.json), served only at
// the fixed /fake-xdg XDG root the lang tests pass; null = absent.
let userConfigJson: string | null = null;
const FAKE_USER_CONFIG = path.join("/fake-xdg", "zcode-acp", "config.json");

/** The settings path the bridge should consult for the CURRENT env — exact
 *  match, so a ZCODE_HOME test can serve content only at the overridden root
 *  (a suffix match would also serve the real `~/.zcode` spelling). */
function expectedSettingsPath(): string {
  const root = process.env.ZCODE_HOME ?? path.join(os.homedir(), ".zcode");
  return path.join(root, "v2", "setting.json");
}

vi.mock("node:fs", () => ({
  readFileSync: (p: unknown) => {
    if (userConfigJson !== null && String(p) === FAKE_USER_CONFIG) {
      return userConfigJson;
    }
    if (settingJson !== null && String(p) === expectedSettingsPath()) {
      return settingJson;
    }
    throw new Error("ENOENT (fake)");
  },
}));

async function freshModule() {
  vi.resetModules();
  return import("../src/i18n.js");
}

beforeEach(() => {
  settingJson = null;
  userConfigJson = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLanguage", () => {
  it("defaults to English with nothing configured", async () => {
    const { resolveLanguage } = await freshModule();
    expect(resolveLanguage({})).toBe("en");
  });

  it("ZCODE_ACP_LANG wins over everything (prefix + case-insensitive)", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = JSON.stringify({ locale: "zh-CN" });
    expect(resolveLanguage({ ZCODE_ACP_LANG: "en" })).toBe("en");
    expect(resolveLanguage({ ZCODE_ACP_LANG: "ZH_CN.UTF-8", LANG: "en_US" })).toBe("zh");
  });

  it("config-file lang wins over env, app locale, and POSIX", async () => {
    const { resolveLanguage } = await freshModule();
    userConfigJson = JSON.stringify({ lang: "zh" });
    settingJson = JSON.stringify({ localePreference: "en-US" });
    expect(
      resolveLanguage({ XDG_CONFIG_HOME: "/fake-xdg", ZCODE_ACP_LANG: "en", LANG: "en_US" }),
    ).toBe("zh");
  });

  it("inherits the app's localePreference, then locale", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = JSON.stringify({ localePreference: "zh-CN", locale: "en-US" });
    expect(resolveLanguage({})).toBe("zh");
    settingJson = JSON.stringify({ locale: "zh-CN" });
    expect(resolveLanguage({})).toBe("zh");
  });

  it("treats an empty-string localePreference as unset", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = JSON.stringify({ localePreference: "", locale: "zh-CN" });
    expect(resolveLanguage({})).toBe("zh");
  });

  it("parses a BOM-prefixed settings file", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = "\uFEFF" + JSON.stringify({ locale: "zh-CN" });
    expect(resolveLanguage({})).toBe("zh");
  });

  it("never crashes on non-string app locale values (number/bool/null/array/object)", async () => {
    // A fresh module per value — memoization would otherwise short-circuit
    // every file parse after the first.
    for (const bad of [5, true, null, [], { x: 1 }]) {
      const { resolveLanguage } = await freshModule();
      settingJson = JSON.stringify({ locale: bad });
      expect(resolveLanguage({ LANG: "zh_CN" })).toBe("zh"); // falls through
      expect(resolveLanguage({})).toBe("en"); // default
    }
  });

  it("memoizes the app-settings read — a later file change does not flip the language", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = JSON.stringify({ locale: "zh-CN" });
    expect(resolveLanguage({})).toBe("zh");
    settingJson = JSON.stringify({ locale: "en-US" });
    expect(resolveLanguage({})).toBe("zh"); // cached, not re-read
    settingJson = JSON.stringify({ locale: null });
    expect(resolveLanguage({})).toBe("zh"); // null value must not bust the cache
  });

  it("reads the app settings file from ZCODE_HOME when set", async () => {
    vi.stubEnv("ZCODE_HOME", "/alt-zcode-home");
    const { resolveLanguage } = await freshModule();
    settingJson = JSON.stringify({ localePreference: "zh-CN" });
    // The mock serves content ONLY at /alt-zcode-home/v2/setting.json — the
    // real ~/.zcode spelling stays absent, so "zh" proves the override.
    expect(resolveLanguage({ LANG: "en_US" })).toBe("zh");
  });

  it("falls through a missing or malformed app settings file", async () => {
    const { resolveLanguage } = await freshModule();
    settingJson = "{not json";
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    settingJson = null;
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(resolveLanguage({ LANG: "en_US.UTF-8" })).toBe("en");
  });

  it("sniffs LC_ALL before LC_MESSAGES before LANG", async () => {
    const { resolveLanguage } = await freshModule();
    expect(resolveLanguage({ LC_ALL: "en_US", LANG: "zh_CN" })).toBe("en");
    expect(resolveLanguage({ LC_MESSAGES: "zh_CN", LANG: "en_US" })).toBe("zh");
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(resolveLanguage({ LANG: "C" })).toBe("en");
  });
});

describe("message tables", () => {
  it("every entry is a non-empty string (functions called with dummy args)", async () => {
    const { messages } = await freshModule();
    vi.stubEnv("ZCODE_ACP_LANG", "zh");
    const zh = Object.values(messages());
    vi.stubEnv("ZCODE_ACP_LANG", "en");
    const en = Object.values(messages());
    for (const value of [...zh, ...en]) {
      const strings =
        typeof value === "function"
          ? [value(["x"], 1, 2, "err")]
          : typeof value === "object" && value !== null
            ? Object.values(value)
            : [value];
      expect(strings.length).toBeGreaterThan(0);
      for (const s of strings) {
        expect(typeof s).toBe("string");
        expect(s.length).toBeGreaterThan(0);
      }
    }
    expect(zh.length).toBe(en.length);
  });

  it("slashCommandDescriptions: identical key sets covering every static command", async () => {
    const { messages } = await freshModule();
    const { SLASH_COMMANDS } = await import("../src/utils.js");
    vi.stubEnv("ZCODE_ACP_LANG", "zh");
    const zhKeys = Object.keys(messages().slashCommandDescriptions).sort();
    vi.stubEnv("ZCODE_ACP_LANG", "en");
    const enKeys = Object.keys(messages().slashCommandDescriptions).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const cmd of SLASH_COMMANDS) {
      expect(zhKeys).toContain(cmd.name);
      expect(enKeys).toContain(cmd.name);
    }
  });

  it("messages() follows env changes per call", async () => {
    const { messages } = await freshModule();
    vi.stubEnv("ZCODE_ACP_LANG", "zh");
    expect(messages().sandboxOptionAllowAlways).toBe("始终允许");
    vi.stubEnv("ZCODE_ACP_LANG", "en");
    expect(messages().sandboxOptionAllowAlways).toBe("Always allow");
  });
});
