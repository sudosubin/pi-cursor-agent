import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import { KILO_API_BASE } from "../lib/env.js";

const KILO_DEVICE_AUTH_CODES_URL = `${KILO_API_BASE}/api/device-auth/codes`;
const KILO_PROFILE_URL = `${KILO_API_BASE}/api/profile`;
const KILO_POLL_INTERVAL_MS = 3000;
const KILO_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const KILO_ORGANIZATION_HEADER = "X-KiloCode-OrganizationId";

// Auth responses are small; cap at 1 MB to prevent memory exhaustion from a
// malicious or compromised server.
const MAX_AUTH_RESPONSE_BYTES = 1 * 1024 * 1024;

// Org IDs are server-supplied and get injected verbatim into HTTP headers.
// Reject anything containing control characters (including CR/LF) to prevent
// header-injection attacks. Modern fetch implementations also guard this, but
// defence-in-depth is cheap here.
const SAFE_HEADER_VALUE_RE = /^[^\r\n\x00-\x1f\x7f]+$/

interface DeviceAuthInitiateResponse {
  code: string;
  verificationUrl: string;
  expiresIn: number;
}

type DeviceAuthPollResponse =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; token: string; userEmail: string };

interface KiloOrganization {
  id: string;
  name: string;
  role: string;
}

interface KiloProfileResponse {
  user?: { email?: string; name?: string };
  email?: string;
  name?: string;
  organizations?: KiloOrganization[];
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Login cancelled"));
      },
      { once: true },
    );
  });
}

async function fetchJson<T>(
  input: string,
  init?: RequestInit,
): Promise<{ response: Response; data: T | null }> {
  const response = await fetch(input, init);

  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > MAX_AUTH_RESPONSE_BYTES
  ) {
    throw new Error(
      `Response too large: ${contentLength} bytes (limit ${MAX_AUTH_RESPONSE_BYTES})`,
    );
  }

  const text = await response.text();
  if (text.length > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error(
      `Response body too large (limit ${MAX_AUTH_RESPONSE_BYTES} bytes)`,
    );
  }

  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    // caller must check for null on a successful status
  }

  return { response, data };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function getProfileEmail(profile: KiloProfileResponse, fallback?: string) {
  return profile.user?.email ?? profile.email ?? fallback;
}

function getProfileName(profile: KiloProfileResponse) {
  return profile.user?.name ?? profile.name;
}

function getOrganizationId(credentials: OAuthCredentials): string | undefined {
  const value = credentials["accountId"];
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Reject values with control characters to prevent HTTP header injection.
  if (!SAFE_HEADER_VALUE_RE.test(value)) return undefined;
  return value;
}

function toOAuthCredentials(input: {
  token: string;
  profile?: KiloProfileResponse;
  accountId?: string;
  fallbackEmail?: string;
}): OAuthCredentials {
  return {
    refresh: input.token,
    access: input.token,
    expires: Date.now() + KILO_TOKEN_TTL_MS,
    accountId: input.accountId,
    email: input.profile
      ? getProfileEmail(input.profile, input.fallbackEmail)
      : input.fallbackEmail,
    name: input.profile ? getProfileName(input.profile) : undefined,
  };
}

async function initiateDeviceAuth(): Promise<DeviceAuthInitiateResponse> {
  const { response, data } = await fetchJson<DeviceAuthInitiateResponse>(
    KILO_DEVICE_AUTH_CODES_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
  );

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "Too many pending authorization requests. Please try again later.",
      );
    }
    throw new Error(
      `Failed to initiate device authorization: ${response.status}`,
    );
  }

  if (!data) {
    throw new Error("Device authorization response is missing or unparseable");
  }

  return data;
}

async function pollDeviceAuth(code: string): Promise<DeviceAuthPollResponse> {
  const { response, data } = await fetchJson<DeviceAuthPollResponse>(
    `${KILO_DEVICE_AUTH_CODES_URL}/${code}`,
  );

  if (response.status === 202) return { status: "pending" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };
  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`);
  }

  if (!data) {
    throw new Error("Device auth poll response is missing or unparseable");
  }

  return data;
}

async function fetchProfile(token: string): Promise<KiloProfileResponse> {
  const { response, data } = await fetchJson<KiloProfileResponse>(
    KILO_PROFILE_URL,
    {
      headers: authHeaders(token),
    },
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Invalid token");
    }
    throw new Error(`Failed to fetch profile: ${response.status}`);
  }

  if (!data) {
    throw new Error("Profile response is missing or unparseable");
  }

  return data;
}

function formatOrganizationPrompt(organizations: KiloOrganization[]) {
  const options = [
    "0. Personal Account",
    ...organizations.map((org, index) => `${index + 1}. ${org.name}`),
  ].join("\n");
  return `${options}\nEnter a number:`;
}

async function selectOrganization(
  organizations: KiloOrganization[] | undefined,
  callbacks: OAuthLoginCallbacks,
): Promise<string | undefined> {
  if (!organizations?.length) return undefined;

  const response = (
    await callbacks.onPrompt({
      message: `Select account:\n${formatOrganizationPrompt(organizations)}`,
      placeholder: "0",
      allowEmpty: true,
    })
  ).trim();

  if (response === "" || response === "0") return undefined;

  const index = Number.parseInt(response, 10);
  if (Number.isNaN(index) || index < 1 || index > organizations.length)
    return undefined;

  return organizations[index - 1]?.id;
}

async function waitForAuthorization(
  code: string,
  expiresIn: number,
  callbacks: OAuthLoginCallbacks,
): Promise<Extract<DeviceAuthPollResponse, { status: "approved" }>> {
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) throw new Error("Login cancelled");

    const result = await pollDeviceAuth(code);
    if (result.status === "approved") return result;
    if (result.status === "denied")
      throw new Error("Authorization denied by user");
    if (result.status === "expired")
      throw new Error("Authorization code expired");

    callbacks.onProgress?.("Waiting for browser authorization...");
    await abortableSleep(KILO_POLL_INTERVAL_MS, callbacks.signal);
  }

  throw new Error("Authentication timed out. Please try again.");
}

export async function login(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const authData = await initiateDeviceAuth();

  callbacks.onAuth({
    url: authData.verificationUrl,
    instructions: `Open ${authData.verificationUrl} and enter code: ${authData.code}`,
  });

  const result = await waitForAuthorization(
    authData.code,
    authData.expiresIn,
    callbacks,
  );
  if (!result.token) {
    throw new Error("Authentication failed: missing token");
  }

  callbacks.onProgress?.(
    `Authenticated${result.userEmail ? ` as ${result.userEmail}` : ""}. Fetching profile...`,
  );
  const profile = await fetchProfile(result.token);
  const accountId = await selectOrganization(profile.organizations, callbacks);

  return toOAuthCredentials({
    token: result.token,
    profile,
    ...(accountId ? { accountId } : {}),
    ...(result.userEmail ? { fallbackEmail: result.userEmail } : {}),
  });
}

export async function refreshToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const token = String(credentials.access);
  await fetchProfile(token);
  return {
    ...credentials,
    refresh: String(credentials.refresh || token),
    access: token,
    expires: Date.now() + KILO_TOKEN_TTL_MS,
  };
}

export function getApiKey(credentials: OAuthCredentials): string {
  return String(credentials.access);
}

export function modifyModels(
  models: Model<Api>[],
  credentials: OAuthCredentials,
): Model<Api>[] {
  const organizationId = getOrganizationId(credentials);
  if (!organizationId) return models;

  return models.map((model) => {
    if (model.provider !== "kilocode") return model;
    return {
      ...model,
      headers: {
        ...model.headers,
        [KILO_ORGANIZATION_HEADER]: organizationId,
      },
    };
  });
}
