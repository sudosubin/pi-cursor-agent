import { createHash, randomBytes } from "node:crypto";
import type { OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type Auth from "../api/auth";
import { backoff } from "./backoff";

type OnAuth = (info: { url: string; instructions: string }) => void;
type OnProgress = (message: string) => void;

class AuthManager {
  constructor(
    private readonly auth: Auth,
    private readonly websiteUrl: string,
  ) {}

  public async login({
    onAuth,
    onProgress,
    signal,
  }: {
    onAuth: OnAuth;
    onProgress?: OnProgress;
    signal?: AbortSignal;
  }) {
    const { uuid, verifier, loginUrl } = this.generateAuthParams();

    const instructions = "Complete the sign-in in your browser.";
    onAuth({ url: loginUrl, instructions });

    return await this.pollAuthenticationStatus({
      uuid,
      verifier,
      onProgress,
      signal,
    });
  }

  public async refresh(credentials: {
    access: string;
    refresh: string;
  }): Promise<{ access: string; refresh: string; expires: number }> {
    if (!credentials.access && !credentials.refresh) {
      throw new Error("No credentials provided");
    }

    try {
      const { accessToken } = await this.auth.exchangeUserApiKey({
        token: credentials.refresh || credentials.access,
      });
      const expires = getTokenExpiry(accessToken);
      // Keep the original refresh credential: exchangeUserApiKey returns a
      // JWT that cannot be used for a subsequent exchange. The stored
      // refresh value (e.g. a long-lived `crsr_` API key) is the only
      // credential that stays valid across refreshes.
      return {
        access: accessToken,
        refresh: credentials.refresh,
        expires,
      };
    } catch {
      // If the refresh token is invalid, try to refresh it with access token
      if (credentials.access && credentials.refresh) {
        return this.refresh({ access: credentials.access, refresh: "" });
      }
      throw new Error("Failed to refresh credentials");
    }
  }

  private generateAuthParams() {
    const verifier = base64URLEncode(randomBytes(32));
    const challenge = base64URLEncode(
      createHash("sha256").update(verifier).digest(),
    );
    const uuid = crypto.randomUUID();
    const loginUrl = `${this.websiteUrl}/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli`;
    return { challenge, uuid, verifier, loginUrl };
  }

  private async pollAuthenticationStatus({
    uuid,
    verifier,
    onProgress,
    signal,
  }: {
    uuid: string;
    verifier: string;
    onProgress?: OAuthLoginCallbacks["onProgress"];
    signal?: AbortSignal | undefined;
  }) {
    return backoff(
      async () => {
        onProgress?.("Polling authentication status...");
        const tokens = await this.auth.poll({ uuid, verifier, signal });
        const { accessToken, refreshToken } = tokens;
        const expires = getTokenExpiry(accessToken);
        return { access: accessToken, refresh: refreshToken, expires };
      },
      {
        retries: 150,
        delay: 1000,
        shouldRetry: (error) =>
          error instanceof Error &&
          error.message.includes("/auth/poll") &&
          error.message.includes("404"),
      },
    );
  }
}

type JwtPayload = {
  exp: number;
  [key: string]: unknown;
};

const base64URLEncode = (buffer: Buffer) => {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const decodeJwt = (token: string): JwtPayload | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const decoded = atob(payload);
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
};

const getTokenExpiry = (token: string): number => {
  try {
    const decoded = decodeJwt(token);
    if (!decoded || typeof decoded.exp !== "number") {
      return Date.now() + 3600 * 1000;
    }
    return decoded.exp * 1000 - 5 * 60 * 1000;
  } catch {
    return Date.now() + 3600 * 1000;
  }
};

export default AuthManager;
