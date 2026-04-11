import assert from "node:assert/strict";
import test from "node:test";
import { convertToPiModels } from "../src/provider/models";

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
