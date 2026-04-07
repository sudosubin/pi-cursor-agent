import assert from "node:assert/strict";
import test from "node:test";
import { getApiKey, modifyModels, refreshToken } from "../src/provider/oauth";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type KiloModel = Parameters<typeof modifyModels>[0][number];

function kilocodeModel(id = "kilo-auto/free"): KiloModel {
  return {
    id,
    name: "Kilo Free",
    api: "openai-completions",
    provider: "kilocode",
    baseUrl: "https://api.kilo.ai/api/openrouter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

// ---------------------------------------------------------------------------
// modifyModels – org header injection
// ---------------------------------------------------------------------------

test("modifyModels adds organization header for kilocode models only", () => {
  const models = modifyModels(
    [
      kilocodeModel(),
      {
        id: "claude-sonnet",
        name: "Other",
        api: "openai-completions",
        provider: "other",
        baseUrl: "https://example.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
      },
    ] satisfies Parameters<typeof modifyModels>[0],
    { refresh: "token", access: "token", expires: 0, accountId: "org_123" },
  );

  assert.equal(models[0]?.headers?.["X-KiloCode-OrganizationId"], "org_123");
  assert.equal(models[1]?.headers?.["X-KiloCode-OrganizationId"], undefined);
});

test("modifyModels rejects org ID containing CR+LF (header injection guard)", () => {
  const result = modifyModels([kilocodeModel()], {
    refresh: "t",
    access: "t",
    expires: 0,
    accountId: "evil\r\nX-Injected: pwned",
  });
  assert.equal(result[0]?.headers?.["X-KiloCode-OrganizationId"], undefined);
});

test("modifyModels rejects org ID containing bare LF", () => {
  const result = modifyModels([kilocodeModel()], {
    refresh: "t",
    access: "t",
    expires: 0,
    accountId: "evil\nX-Injected: pwned",
  });
  assert.equal(result[0]?.headers?.["X-KiloCode-OrganizationId"], undefined);
});

test("modifyModels rejects org ID containing null byte", () => {
  const result = modifyModels([kilocodeModel()], {
    refresh: "t",
    access: "t",
    expires: 0,
    accountId: "org\x00injected",
  });
  assert.equal(result[0]?.headers?.["X-KiloCode-OrganizationId"], undefined);
});

test("modifyModels rejects org ID containing other control characters", () => {
  const result = modifyModels([kilocodeModel()], {
    refresh: "t",
    access: "t",
    expires: 0,
    accountId: "org\x1binjected",
  });
  assert.equal(result[0]?.headers?.["X-KiloCode-OrganizationId"], undefined);
});

test("modifyModels accepts org ID with letters, digits, hyphens, underscores", () => {
  const result = modifyModels([kilocodeModel()], {
    refresh: "t",
    access: "t",
    expires: 0,
    accountId: "org-123_ABC",
  });
  assert.equal(result[0]?.headers?.["X-KiloCode-OrganizationId"], "org-123_ABC");
});

// ---------------------------------------------------------------------------
// refreshToken – response size limits and invalid JSON
// ---------------------------------------------------------------------------

test("refreshToken validates token via profile fetch and extends expiry", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ user: { email: "user@example.com" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const refreshed = await refreshToken({
    refresh: "abc",
    access: "abc",
    expires: 1,
    accountId: "org_123",
  });

  assert.equal(getApiKey(refreshed), "abc");
  assert.equal(refreshed.accountId, "org_123");
  assert.ok(typeof refreshed.expires === "number");
  assert.ok(refreshed.expires > Date.now());
});

test("refreshToken throws when content-length header exceeds 1 MB limit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024), // 2 MB
      },
    })) as typeof fetch;

  await assert.rejects(
    () => refreshToken({ refresh: "t", access: "t", expires: 0 }),
    /too large/i,
  );
});

test("refreshToken throws when profile response body exceeds 1 MB limit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Slightly over the 1 MB cap; no content-length so the body-length check fires
  const oversized = "x".repeat(1 * 1024 * 1024 + 1);
  globalThis.fetch = (async () =>
    new Response(oversized, { status: 200 })) as typeof fetch;

  await assert.rejects(
    () => refreshToken({ refresh: "t", access: "t", expires: 0 }),
    /too large/i,
  );
});

test("refreshToken throws when profile response is not valid JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response("not json at all", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    () => refreshToken({ refresh: "t", access: "t", expires: 0 }),
    /missing or unparseable/i,
  );
});
