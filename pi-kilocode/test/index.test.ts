import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerKilocodeProvider from "../src/index";
import {
  KILO_GATEWAY_BASE_URL,
  PI_KILOCODE_MODELS_CACHE_FILE,
} from "../src/lib/env";
import {
  getCachedPiModels,
  resetPiKilocodeModelCacheForTests,
} from "../src/provider/models";

type RegisteredProviderConfig = {
  baseUrl: string;
  apiKey: string;
  api: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  oauth?: {
    name: string;
    login: (...args: unknown[]) => Promise<unknown>;
    refreshToken: (...args: unknown[]) => Promise<unknown>;
    getApiKey: (...args: unknown[]) => string;
    modifyModels?: (...args: unknown[]) => unknown;
  };
  models: Array<{
    id: string;
    name: string;
    cost: { input: number; output: number };
  }>;
};

function createMockPi() {
  const providerCalls: Array<{
    name: string;
    config: RegisteredProviderConfig;
  }> = [];
  type EventHandler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, EventHandler[]>();

  const api = {
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerProvider(name: string, config: RegisteredProviderConfig) {
      providerCalls.push({ name, config });
    },
  };

  return { api: api as unknown as ExtensionAPI, providerCalls, handlers };
}

test("registers kilocode provider once and refreshes cache from live raw response on demand", async (t) => {
  resetPiKilocodeModelCacheForTests();

  const hadCache = fs.existsSync(PI_KILOCODE_MODELS_CACHE_FILE);
  const originalCache = hadCache
    ? fs.readFileSync(PI_KILOCODE_MODELS_CACHE_FILE, "utf8")
    : undefined;
  if (hadCache) {
    fs.rmSync(PI_KILOCODE_MODELS_CACHE_FILE, { force: true });
  }

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    resetPiKilocodeModelCacheForTests();
    if (originalCache !== undefined) {
      fs.mkdirSync(path.dirname(PI_KILOCODE_MODELS_CACHE_FILE), {
        recursive: true,
      });
      fs.writeFileSync(PI_KILOCODE_MODELS_CACHE_FILE, originalCache);
    } else {
      fs.rmSync(PI_KILOCODE_MODELS_CACHE_FILE, { force: true });
    }
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "demo/paid-model",
            name: "Paid model",
            created: 1,
            description: "Paid model",
            isFree: false,
            context_length: 32000,
            max_completion_tokens: 4096,
            supported_parameters: ["tools"],
            pricing: { prompt: "0.000001", completion: "0.000002" },
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
              tokenizer: "Other",
            },
            top_provider: {
              is_moderated: false,
              context_length: 32000,
              max_completion_tokens: 4096,
            },
          },
          {
            id: "demo/free-model:free",
            name: "Free text model",
            created: 2,
            description: "Free text model",
            isFree: true,
            context_length: 64000,
            max_completion_tokens: 8192,
            supported_parameters: ["tools", "reasoning"],
            pricing: { prompt: "0.000003", completion: "0.000004" },
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              tokenizer: "Other",
            },
            top_provider: {
              is_moderated: false,
              context_length: 64000,
              max_completion_tokens: 8192,
            },
          },
          {
            id: "demo/image-only:free",
            name: "Free image generator",
            created: 3,
            description: "Free image generator",
            isFree: true,
            context_length: 64000,
            max_completion_tokens: 8192,
            supported_parameters: ["reasoning"],
            pricing: { prompt: "0.000005", completion: "0.000006" },
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["image"],
              tokenizer: "Other",
            },
            top_provider: {
              is_moderated: false,
              context_length: 64000,
              max_completion_tokens: 8192,
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const pi = createMockPi();
  registerKilocodeProvider(pi.api);

  assert.equal(pi.providerCalls.length, 1);

  const initial = pi.providerCalls[0];
  assert.equal(initial?.name, "kilocode");
  assert.equal(initial?.config.baseUrl, KILO_GATEWAY_BASE_URL);
  assert.equal(initial?.config.apiKey, "KILO_API_KEY");
  assert.equal(initial?.config.api, "openai-completions");
  assert.equal(initial?.config.authHeader, false);
  assert.deepEqual(initial?.config.headers, { "X-KILOCODE-EDITORNAME": "pi" });
  assert.equal(initial?.config.oauth?.name, "Kilo Code");
  assert.equal(typeof initial?.config.oauth?.login, "function");
  assert.equal(typeof initial?.config.oauth?.refreshToken, "function");
  assert.equal(typeof initial?.config.oauth?.getApiKey, "function");
  assert.equal(typeof initial?.config.oauth?.modifyModels, "function");
  assert.deepEqual(initial?.config.models, []);

  const sessionStartHandlers = pi.handlers.get("session_start") ?? [];
  assert.equal(sessionStartHandlers.length, 1);
  await sessionStartHandlers[0]?.({}, {});

  for (
    let i = 0;
    i < 20 && !fs.existsSync(PI_KILOCODE_MODELS_CACHE_FILE);
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const cached = JSON.parse(
    fs.readFileSync(PI_KILOCODE_MODELS_CACHE_FILE, "utf8"),
  ) as {
    data: { data: Array<{ id: string }> };
  };
  assert.deepEqual(
    cached.data.data.map((model) => model.id),
    ["demo/paid-model", "demo/free-model:free", "demo/image-only:free"],
  );

  assert.deepEqual(
    getCachedPiModels().map((model) => model.id),
    ["demo/paid-model", "demo/free-model:free"],
  );

  assert.equal(pi.providerCalls.length, 1);
  assert.equal(pi.handlers.has("session_start"), true);
  assert.equal(pi.handlers.has("session_switch"), true);
  assert.equal(pi.handlers.has("model_select"), true);
});
