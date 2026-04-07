import fs from "node:fs";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import {
  KILO_MODELS_URL,
  PI_KILOCODE_CACHE_DIR,
  PI_KILOCODE_MODELS_CACHE_FILE,
  PI_KILOCODE_MODELS_CACHE_TTL_MS,
} from "../lib/env.js";

interface KiloModel {
  id: string;
  name: string;
  created: number;
  description: string;
  context_length: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
    modality?: string;
    instruct_type?: string | null;
  };
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
    input_cache_write?: string;
    input_cache_read?: string;
  };
  top_provider: {
    is_moderated: boolean;
    context_length: number;
    max_completion_tokens: number | null;
  };
  supported_parameters: string[];
  isFree: boolean;
  max_completion_tokens?: number | null;
  opencode?: {
    family?: string;
    prompt?: string;
    variants?: Record<string, Record<string, unknown>>;
  };
  preferredIndex?: number;
  canonical_slug?: string;
  default_parameters?: Record<string, unknown>;
  hugging_face_id?: string;
  per_request_limits?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  versioned_settings?: Record<string, unknown>;
}

interface KiloModelsResponse {
  data: KiloModel[];
}

interface CachedModelsFile {
  data: KiloModelsResponse;
  lastUpdatedAt?: string;
}

function parsePrice(v: string | null | undefined): number {
  if (!v) return 0;
  const n = Number.parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

function toMillionDollarRate(perToken: number): number {
  return perToken * 1_000_000;
}

function isValidCacheFile(value: unknown): value is CachedModelsFile {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (!c["data"] || typeof c["data"] !== "object") return false;
  const d = c["data"] as Record<string, unknown>;
  return Array.isArray(d["data"]);
}

function readCache(): CachedModelsFile | null {
  try {
    if (!fs.existsSync(PI_KILOCODE_MODELS_CACHE_FILE)) {
      return null;
    }
    const raw: unknown = JSON.parse(
      fs.readFileSync(PI_KILOCODE_MODELS_CACHE_FILE, "utf8"),
    );
    return isValidCacheFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

function isCacheStale(cache: CachedModelsFile | null) {
  if (!cache?.lastUpdatedAt) return true;
  const lastUpdatedAt = Date.parse(cache.lastUpdatedAt);
  return (
    Number.isNaN(lastUpdatedAt) ||
    Date.now() - lastUpdatedAt >= PI_KILOCODE_MODELS_CACHE_TTL_MS
  );
}

// Model list responses can be large but are bounded; 50 MB is generous.
const MAX_MODELS_RESPONSE_BYTES = 50 * 1024 * 1024;

export async function fetchKiloModels(): Promise<KiloModelsResponse> {
  const res = await fetch(KILO_MODELS_URL, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Kilo models fetch failed: ${res.status}`);
  }

  const contentLength = res.headers.get("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > MAX_MODELS_RESPONSE_BYTES
  ) {
    throw new Error(
      `Models response too large: ${contentLength} bytes (limit ${MAX_MODELS_RESPONSE_BYTES})`,
    );
  }

  const text = await res.text();
  if (text.length > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error(
      `Models response body too large (limit ${MAX_MODELS_RESPONSE_BYTES} bytes)`,
    );
  }

  const data = JSON.parse(text) as KiloModelsResponse;
  if (!Array.isArray(data?.data)) {
    throw new Error("Models response has unexpected shape");
  }

  return data;
}

function toPiModel(m: KiloModel): ProviderModelConfig {
  const supportsReasoning =
    m.supported_parameters?.includes("reasoning") ?? false;
  const supportsImage =
    m.architecture?.input_modalities?.includes("image") ?? false;
  const maxOut =
    m.top_provider?.max_completion_tokens ??
    m.max_completion_tokens ??
    Math.ceil(m.context_length * 0.2);
  const inputPrice = parsePrice(m.pricing?.prompt);
  const outputPrice = parsePrice(m.pricing?.completion);
  const cacheRead = parsePrice(m.pricing?.input_cache_read);
  const cacheWrite = parsePrice(m.pricing?.input_cache_write);

  return {
    id: m.id,
    name: m.name,
    reasoning: supportsReasoning,
    input: supportsImage ? ["text", "image"] : ["text"],
    cost: {
      input: toMillionDollarRate(inputPrice),
      output: toMillionDollarRate(outputPrice),
      cacheRead: toMillionDollarRate(cacheRead),
      cacheWrite: toMillionDollarRate(cacheWrite),
    },
    contextWindow: m.context_length,
    maxTokens: maxOut ?? 8192,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      thinkingFormat: supportsReasoning ? "openrouter" : undefined,
    },
  };
}

export function convertToPiModels(raw: KiloModel[]): ProviderModelConfig[] {
  return raw
    .filter((m) => {
      const out = m.architecture.output_modalities;
      return !(out.includes("image") && !out.includes("text"));
    })
    .map(toPiModel);
}

export function filterFreeModels(raw: KiloModel[]): KiloModel[] {
  return raw.filter((m) => m.isFree);
}

let updateInFlight: Promise<void> | null = null;

export function getCachedPiModels(): ProviderModelConfig[] {
  return convertToPiModels(filterFreeModels(readCache()?.data.data ?? []));
}

async function updateCachedPiModels() {
  const [data] = await Promise.all([
    fetchKiloModels(),
    fs.promises.mkdir(PI_KILOCODE_CACHE_DIR, { recursive: true }),
  ]);

  const cache: CachedModelsFile = {
    data,
    lastUpdatedAt: new Date().toISOString(),
  };

  await fs.promises.writeFile(
    PI_KILOCODE_MODELS_CACHE_FILE,
    JSON.stringify(cache, null, 2),
  );
}

export async function updateCachedPiModelsIfStale(): Promise<
  ProviderModelConfig[]
> {
  if (updateInFlight) {
    await updateInFlight;
    return getCachedPiModels();
  }

  if (!isCacheStale(readCache())) {
    return getCachedPiModels();
  }

  updateInFlight = updateCachedPiModels().finally(() => {
    updateInFlight = null;
  });

  try {
    await updateInFlight;
  } catch {}

  return getCachedPiModels();
}

export function resetPiKilocodeModelCacheForTests() {
  updateInFlight = null;
}
