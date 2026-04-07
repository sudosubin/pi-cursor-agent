import os from "node:os";
import path from "node:path";

export const KILO_API_BASE = "https://api.kilo.ai";
export const KILO_GATEWAY_BASE_URL = `${KILO_API_BASE}/api/openrouter`;
export const KILO_MODELS_URL = `${KILO_API_BASE}/api/gateway/models`;

const rawDir =
  process.env["PI_CODING_AGENT_DIR"] || path.join(os.homedir(), ".pi", "agent");

// Guard against null-byte injection; resolve to an absolute, normalised path.
if (rawDir.includes("\x00")) {
  throw new Error("PI_CODING_AGENT_DIR contains invalid characters (null byte)");
}

export const PI_CODING_AGENT_DIR = path.resolve(rawDir);

export const PI_KILOCODE_CACHE_DIR = path.join(
  PI_CODING_AGENT_DIR,
  "cache",
  "pi-kilocode",
);
export const PI_KILOCODE_MODELS_CACHE_FILE = path.join(
  PI_KILOCODE_CACHE_DIR,
  "models.json",
);
export const PI_KILOCODE_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
