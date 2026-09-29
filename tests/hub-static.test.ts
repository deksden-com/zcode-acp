/**
 * Hub same-origin static hosting (web-static-hosting spec §8): the opt-in
 * webDir mount, cache/MIME headers, traversal + symlink defenses, route
 * precedence over the static tree, and the silent-degradation posture when
 * webDir points nowhere. Raw `http.request` drives the checks so exact path
 * bytes (dot segments, percent-encoded spellings) reach the server verbatim
 * — fetch/URL would normalize some of them client-side.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startHub, type HubHandle } from "../src/remote/hub-server.js";

const TOKEN = "test-hub-token";

const cleanups: Array<() => Promise<void> | void> = [];

async function startTestHub(opts: { webDir?: string } = {}): Promise<HubHandle> {
  const hub = await startHub({ port: 0, host: "127.0.0.1", token: TOKEN, ...opts });
  cleanups.push(() => hub.close());
  return hub;
}

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()!;
    await stop();
  }
});

interface RawReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Send the path bytes verbatim (no client-side URL normalization). */
function rawRequest(port: number, rawPath: string, method = "GET"): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: rawPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

const header = (r: RawReply, name: string): string | undefined => {
  const v = r.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** A web-client build fixture: index.html, hashed assets, root-level files. */
async function buildWebDist(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "zacp-web-"));
  const root = path.join(base, "dist");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "index.html"), "<html>same-origin app</html>");
  const assets: Array<[string, string]> = [
    ["index-Ab12Cd.js", "console.log(1)"],
    ["eng-05.mjs", "export default 1"],
    ["app-XYZ.css", "body{}"],
    ["logo-E9.svg", "<svg/>"],
    ["img-11.png", "png-bytes"],
    ["f-12.woff2", "font-bytes"],
    ["data-77.json", "{}"],
    ["code-33.map", "{}"],
  ];
  for (const [name, body] of assets) {
    await writeFile(path.join(root, "assets", name), body);
  }
  await writeFile(path.join(root, "favicon.ico"), "ico-bytes");
  await writeFile(path.join(root, "manifest-9.webmanifest"), "{}");
  await writeFile(path.join(root, "robots.txt"), "User-agent: *");
  // The traversal/symlink targets live OUTSIDE the serving root.
  await writeFile(path.join(outside, "secret.txt"), "top secret");
  await writeFile(path.join(outside, "escape.js"), "escaped");
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return { root, outside };
}

describe("hub static hosting (webDir)", () => {
  it("unset webDir keeps today's 404s byte-for-byte", async () => {
    const hub = await startTestHub();
    const slash = await rawRequest(hub.port, "/");
    expect(slash.status).toBe(404);
    expect(slash.body).toBe("not found");
    const asset = await rawRequest(hub.port, "/assets/x.js");
    expect(asset.status).toBe(404);
  });

  it("serves index.html no-cache, hashed assets immutable, MIME table, nosniff", async () => {
    const { root } = await buildWebDist();
    const hub = await startTestHub({ webDir: root });

    const index = await rawRequest(hub.port, "/");
    expect(index.status).toBe(200);
    expect(index.body).toContain("same-origin app");
    expect(header(index, "content-type")).toBe("text/html; charset=utf-8");
    expect(header(index, "cache-control")).toBe("no-cache");
    expect(header(index, "x-content-type-options")).toBe("nosniff");

    const js = await rawRequest(hub.port, "/assets/index-Ab12Cd.js");
    expect(js.status).toBe(200);
    expect(header(js, "content-type")).toBe("text/javascript; charset=utf-8");
    expect(header(js, "cache-control")).toBe("public, max-age=31536000, immutable");
    expect(header(js, "x-content-type-options")).toBe("nosniff");

    const mimeCases: Array<[string, string]> = [
      ["/assets/eng-05.mjs", "text/javascript; charset=utf-8"],
      ["/assets/app-XYZ.css", "text/css; charset=utf-8"],
      ["/assets/logo-E9.svg", "image/svg+xml"],
      ["/assets/img-11.png", "image/png"],
      ["/assets/f-12.woff2", "font/woff2"],
      ["/assets/data-77.json", "application/json; charset=utf-8"],
      ["/assets/code-33.map", "application/json; charset=utf-8"],
      ["/favicon.ico", "image/x-icon"],
      ["/manifest-9.webmanifest", "application/manifest+json; charset=utf-8"],
      ["/robots.txt", "text/plain; charset=utf-8"],
    ];
    for (const [p, mime] of mimeCases) {
      const r = await rawRequest(hub.port, p);
      expect(r.status, p).toBe(200);
      expect(header(r, "content-type"), p).toBe(mime);
    }
    // Root-level (non-hashed) files revalidate; only assets/ are immutable.
    expect(header(await rawRequest(hub.port, "/favicon.ico"), "cache-control")).toBe("no-cache");

    // HEAD carries the same headers with no body.
    const head = await rawRequest(hub.port, "/", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(header(head, "content-length")).toBe(String(index.body.length));
  });

  it("rejects traversal, encoded spellings, and symlink escapes with 404", async () => {
    const { root, outside } = await buildWebDist();
    // A symlinked FILE inside assets/ and a symlinked DIRECTORY both point
    // outside the root; the realpath re-check must refuse to serve either.
    await symlink(path.join(outside, "escape.js"), path.join(root, "assets", "escape.js"));
    await symlink(outside, path.join(root, "assets", "linkdir"));
    const hub = await startTestHub({ webDir: root });

    const attacks = [
      "/../secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/%2e%2e/secret.txt",
      // %2f survives URL parsing as a path separator only after decode, so
      // this one reaches serveStatic's own decode+normalize layer.
      "/assets/x%2f..%2f..%2fsecret.txt",
      "/assets/linkdir/secret.txt",
      "/assets/escape.js",
      "/assets/missing.js",
      "/assets",
    ];
    for (const p of attacks) {
      const r = await rawRequest(hub.port, p);
      expect(r.status, p).toBe(404);
    }
  });

  it("keeps API precedence with webDir set (health ok, auth boundary intact)", async () => {
    const { root } = await buildWebDist();
    const hub = await startTestHub({ webDir: root });

    const health = await rawRequest(hub.port, "/api/health");
    expect(health.status).toBe(200);
    expect(health.body).toBe("ok");

    // A path that exists as a static file but is FIRST an API route stays API:
    // /api/* never falls through to the mount. Unauthorized (no token) proves
    // the route answered, not the static tree.
    const instances = await rawRequest(hub.port, "/api/instances");
    expect(instances.status).toBe(401);
  });

  it("answers 404 for non-GET/HEAD on static paths", async () => {
    const { root } = await buildWebDist();
    const hub = await startTestHub({ webDir: root });

    expect((await rawRequest(hub.port, "/", "POST")).status).toBe(404);
    expect((await rawRequest(hub.port, "/index.html", "PUT")).status).toBe(404);
  });

  it("degrades silently when webDir points nowhere: one warning, API only", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const hub = await startTestHub({ webDir: path.join(tmpdir(), "zacp-web-missing") });
      const warnings = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("webDir") && line.includes("static hosting disabled"));
      expect(warnings).toHaveLength(1);
      expect((await rawRequest(hub.port, "/")).status).toBe(404);
      expect((await rawRequest(hub.port, "/api/health")).status).toBe(200);
    } finally {
      stderr.mockRestore();
    }
  });
});
