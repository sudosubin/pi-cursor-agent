import assert from "node:assert/strict";
import test from "node:test";
import { convertToPiModels } from "../src/provider/models";

type RawKiloModel = Parameters<typeof convertToPiModels>[0][number];
type PiModel = ReturnType<typeof convertToPiModels>[number];
type ConvertedPiModel = PiModel & {
  thinkingLevelMap?: Record<string, string | null>;
};

const baseRawModel: RawKiloModel = {
  id: "fixture/model",
  name: "Fixture model",
  created: 1,
  description: "Fixture model",
  context_length: 128_000,
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["text"],
    tokenizer: "Other",
  },
  pricing: { prompt: "0", completion: "0" },
  top_provider: {
    is_moderated: false,
    context_length: 128_000,
    max_completion_tokens: 4096,
  },
  supported_parameters: ["reasoning"],
  isFree: true,
};

function convertModel(
  id: string,
  overrides: Partial<RawKiloModel> = {},
): ConvertedPiModel {
  const [model] = convertToPiModels([
    {
      ...baseRawModel,
      ...overrides,
      id,
    },
  ]);
  assert.ok(model);
  return model as ConvertedPiModel;
}

test("Qwen 3.8 gets exactly the xhigh thinking map", () => {
  const qwen = convertModel("qwen/qwen3.8-max");

  assert.deepEqual(qwen.thinkingLevelMap, { xhigh: "xhigh" });
  assert.deepEqual(Object.keys(qwen.thinkingLevelMap ?? {}), ["xhigh"]);
});

test("nearby and non-Qwen reasoning IDs remain unmapped", () => {
  for (const id of [
    "qwen/qwen3.7-max",
    "qwen/qwen3.8-max-preview",
    "qwen/qwen3.8-max-v2",
    "z-ai/glm-5.2",
  ]) {
    assert.equal(convertModel(id).thinkingLevelMap, undefined, id);
  }
});

test("the exact Qwen ID without reasoning support remains unmapped", () => {
  assert.equal(
    convertModel("qwen/qwen3.8-max", { supported_parameters: [] })
      .thinkingLevelMap,
    undefined,
  );
});

test("the adaptive Opus map remains unchanged", () => {
  assert.deepEqual(convertModel("anthropic/claude-opus-4.8").thinkingLevelMap, {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  });
});
