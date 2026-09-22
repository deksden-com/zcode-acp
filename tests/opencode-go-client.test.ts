/**
 * Header-shape test for the real Opencode Go HTTP client.
 *
 * Lives in its own file (no `vi.mock`) so `fetchGoStatus` is the real
 * implementation and we can assert on the exact request passed to global
 * fetch — the console API contract needs BOTH cookies plus the `x-org-id`
 * header (verified live 2026-09-19: missing session cookie → 401, missing
 * org header → 400). Other opencode-go tests mock the client module.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGoStatus } from "../src/quota/opencode-go/client.js";

describe("fetchGoStatus request shape", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("sends both auth cookies and x-org-id to the console status API", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    await fetchGoStatus("wrk_x", "Fe26.2**secret", "st_123456");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    const url = call[0];
    const init = (call[1] ?? {}) as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(String(url)).toBe("https://opencode.ai/console/api/go/status");
    expect(init.method).toBe("GET");
    expect(headers.Cookie).toBe("auth=Fe26.2**secret; __Host-console_session=st_123456");
    expect(headers["x-org-id"]).toBe("wrk_x");
    expect(headers.Accept).toBe("application/json");
  });

  it("does not throw on 401 — returns the status for the caller to classify", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 401 }));
    const resp = await fetchGoStatus("wrk_x", "Fe26.2**secret", "st_123456");
    expect(resp.status).toBe(401);
  });
});
