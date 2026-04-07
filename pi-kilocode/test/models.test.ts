import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  convertToPiModels,
  fetchKiloModels,
  filterFreeModels,
  getCachedPiModels,
  resetPiKilocodeModelCacheForTests,
} from "../src/provider/models";
import { PI_KILOCODE_MODELS_CACHE_FILE } from "../src/lib/env";

test("filterFreeModels keeps only models with isFree=true", () => {
  const filtered = filterFreeModels([
    {
      id: "demo/paid",
      name: "Paid",
      created: 1,
      description: "Paid",
      context_length: 1000,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "Other",
      },
      pricing: { prompt: "0.1", completion: "0.2" },
      top_provider: {
        is_moderated: false,
        context_length: 1000,
        max_completion_tokens: 100,
      },
      supported_parameters: [],
      isFree: false,
    },
    {
      id: "demo/free",
      name: "Explicit free",
      created: 2,
      description: "Free",
      context_length: 1000,
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "Other",
      },
      pricing: { prompt: "0", completion: "0" },
      top_provider: {
        is_moderated: false,
        context_length: 1000,
        max_completion_tokens: 100,
      },
      supported_parameters: [],
      isFree: true,
    },
  ] satisfies Parameters<typeof filterFreeModels>[0]);

  assert.deepEqual(
    filtered.map((model) => model.id),
    ["demo/free"],
  );
});

test("convertToPiModels drops image-only models and maps capabilities/pricing", () => {
  const converted = convertToPiModels([
    {
      id: "demo/text-and-image-input:free",
      name: "Vision model",
      created: 1,
      description: "Vision model",
      context_length: 128000,
      top_provider: {
        is_moderated: false,
        context_length: 128000,
        max_completion_tokens: 12000,
      },
      supported_parameters: ["tools", "reasoning"],
      pricing: {
        prompt: "0.0000015",
        completion: "0.0000025",
        input_cache_read: "0.0000005",
        input_cache_write: "0.0000035",
      },
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        tokenizer: "Other",
      },
      isFree: true,
    },
    {
      id: "demo/image-only:free",
      name: "Image only",
      created: 2,
      description: "Image only",
      context_length: 128000,
      top_provider: {
        is_moderated: false,
        context_length: 128000,
        max_completion_tokens: 12000,
      },
      supported_parameters: [],
      pricing: {
        prompt: "0",
        completion: "0",
      },
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["image"],
        tokenizer: "Other",
      },
      isFree: true,
    },
  ] satisfies Parameters<typeof convertToPiModels>[0]);

  assert.equal(converted.length, 1);

  const model = converted[0];
  assert.ok(model);
  assert.equal(model.id, "demo/text-and-image-input:free");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.equal(model.maxTokens, 12000);
  assert.deepEqual(model.cost, {
    input: 1.5,
    output: 2.5,
    cacheRead: 0.5,
    cacheWrite: 3.5,
  });
  assert.deepEqual(model.compat, {
    supportsDeveloperRole: false,
    supportsStore: false,
    thinkingFormat: "openrouter",
  });
});

// ---------------------------------------------------------------------------
// fetchKiloModels – response size limits and shape validation
// ---------------------------------------------------------------------------

test("fetchKiloModels throws when content-length header exceeds 50 MB limit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(51 * 1024 * 1024), // 51 MB
      },
    })) as typeof fetch;

  await assert.rejects(() => fetchKiloModels(), /too large/i);
});

test("fetchKiloModels throws when response shape is missing data array", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: "not-an-array" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(() => fetchKiloModels(), /unexpected shape/i);
});

test("fetchKiloModels throws when response is not valid JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response("not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(() => fetchKiloModels(), /SyntaxError|unexpected/i);
});

// ---------------------------------------------------------------------------
// getCachedPiModels – tampered / invalid cache file
// ---------------------------------------------------------------------------

test("getCachedPiModels returns empty array when cache file contains invalid JSON", (t) => {
  resetPiKilocodeModelCacheForTests();

  fs.mkdirSync(path.dirname(PI_KILOCODE_MODELS_CACHE_FILE), { recursive: true });
  fs.writeFileSync(PI_KILOCODE_MODELS_CACHE_FILE, "not json");
  t.after(() => fs.rmSync(PI_KILOCODE_MODELS_CACHE_FILE, { force: true }));

  assert.deepEqual(getCachedPiModels(), []);
});

test("getCachedPiModels returns empty array when cache file has wrong shape", (t) => {
  resetPiKilocodeModelCacheForTests();

  fs.mkdirSync(path.dirname(PI_KILOCODE_MODELS_CACHE_FILE), { recursive: true });
  fs.writeFileSync(
    PI_KILOCODE_MODELS_CACHE_FILE,
    JSON.stringify({ data: { data: "not-an-array" } }),
  );
  t.after(() => fs.rmSync(PI_KILOCODE_MODELS_CACHE_FILE, { force: true }));

  assert.deepEqual(getCachedPiModels(), []);
});

test("getCachedPiModels returns empty array when cache file has unexpected root type", (t) => {
  resetPiKilocodeModelCacheForTests();

  fs.mkdirSync(path.dirname(PI_KILOCODE_MODELS_CACHE_FILE), { recursive: true });
  fs.writeFileSync(PI_KILOCODE_MODELS_CACHE_FILE, JSON.stringify([1, 2, 3]));
  t.after(() => fs.rmSync(PI_KILOCODE_MODELS_CACHE_FILE, { force: true }));

  assert.deepEqual(getCachedPiModels(), []);
});
