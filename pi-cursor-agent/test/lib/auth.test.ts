import assert from "node:assert/strict";
import test from "node:test";
import type Auth from "../../src/api/auth.js";
import AuthManager from "../../src/lib/auth.js";

class MockAuth {
  lastToken = "";
  result: { accessToken: string; refreshToken: string } | null = null;
  error: Error | null = null;

  async exchangeUserApiKey({ token }: { token: string }) {
    this.lastToken = token;
    if (this.error) {
      throw this.error;
    }
    if (!this.result) {
      throw new Error("exchangeUserApiKey called without a mocked result");
    }
    return this.result;
  }

  async poll() {
    throw new Error("poll not mocked");
  }
}

// A JWT with a known exp (in seconds). Payload: { exp: 2000000000 }
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.c2ln";
const NEW_REFRESH_TOKEN = "refresh-returned-by-exchange";

test("refresh keeps the original refresh credential and returns new access", async () => {
  const mockAuth = new MockAuth();
  mockAuth.result = {
    accessToken: ACCESS_TOKEN,
    refreshToken: NEW_REFRESH_TOKEN,
  };
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  const credentials = {
    access: "old-access",
    refresh: "crsr_test-api-key",
  };
  const result = await manager.refresh(credentials);

  // The exchange is always performed with the stored refresh credential.
  assert.equal(mockAuth.lastToken, "crsr_test-api-key");
  // Access token comes from the exchange response...
  assert.equal(result.access, ACCESS_TOKEN);
  // ...but the stored refresh credential is preserved instead of being
  // replaced by the JWT returned from the exchange.
  assert.equal(result.refresh, "crsr_test-api-key");
  // Expiry is derived from the JWT exp (minus the 5-minute safety margin).
  assert.equal(result.expires, 2000000000 * 1000 - 5 * 60 * 1000);
});

test("refresh falls back to the access token when only access is present", async () => {
  const mockAuth = new MockAuth();
  mockAuth.result = {
    accessToken: ACCESS_TOKEN,
    refreshToken: NEW_REFRESH_TOKEN,
  };
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  const credentials = { access: "old-access", refresh: "" };
  const result = await manager.refresh(credentials);

  assert.equal(mockAuth.lastToken, "old-access");
  assert.equal(result.access, ACCESS_TOKEN);
  assert.equal(result.refresh, "");
});

test("refresh rethrows with a descriptive error when both credentials fail", async () => {
  const mockAuth = new MockAuth();
  mockAuth.error = new Error("Invalid User API Key");
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  await assert.rejects(
    manager.refresh({ access: "acc", refresh: "rej" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Failed to refresh credentials");
      return true;
    },
  );
});
