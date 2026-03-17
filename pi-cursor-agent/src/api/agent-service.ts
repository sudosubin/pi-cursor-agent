import {
  type Client,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type {
  AgentClientMessage,
  AgentServerMessage,
} from "../__generated__/agent/v1/agent_pb";
import { AgentService as AgentServiceDef } from "../__generated__/agent/v1/agent_service_connect";
import type { AgentRpcClient } from "../vendor/agent-client";

interface AgentServiceOptions {
  accessToken: string;
  clientType: string;
  clientVersion: string;
}

function getAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

export function wrapAbortSafeStream(
  stream: AsyncIterable<AgentServerMessage>,
  signal: AbortSignal,
): AsyncIterable<AgentServerMessage> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      let done = false;

      const closeIterator = async () => {
        if (done) {
          return { done: true, value: undefined as never };
        }

        done = true;
        return (
          (await iterator.return?.()) ?? {
            done: true,
            value: undefined as never,
          }
        );
      };

      return {
        async next() {
          if (done) {
            return { done: true, value: undefined as never };
          }

          let cleanup = () => {};
          try {
            const aborted = new Promise<never>((_, reject) => {
              const onAbort = () => reject(getAbortError(signal.reason));

              if (signal.aborted) {
                onAbort();
                return;
              }

              signal.addEventListener("abort", onAbort, { once: true });
              cleanup = () => {
                signal.removeEventListener("abort", onAbort);
              };
            });

            const result = await Promise.race([iterator.next(), aborted]);
            if (result.done) {
              done = true;
            }
            return result;
          } catch (error) {
            await closeIterator();
            throw error;
          } finally {
            cleanup();
          }
        },
        async return() {
          return closeIterator();
        },
        async throw(error) {
          done = true;
          if (iterator.throw) {
            return iterator.throw(error);
          }
          throw error;
        },
      };
    },
  };
}

class AgentService {
  private readonly client: Client<typeof AgentServiceDef>;

  constructor(baseUrl: string, options: AgentServiceOptions) {
    const authInterceptor: Interceptor = (next) => async (req) => {
      req.header.set("authorization", `Bearer ${options.accessToken}`);
      req.header.set("x-cursor-client-type", options.clientType);
      req.header.set("x-cursor-client-version", options.clientVersion);
      req.header.set("x-ghost-mode", "true");
      req.header.set("x-request-id", crypto.randomUUID());
      return next(req);
    };

    const transport = createConnectTransport({
      baseUrl,
      httpVersion: "2",
      interceptors: [authInterceptor],
    });

    this.client = createClient(AgentServiceDef, transport);
  }

  get rpcClient(): AgentRpcClient {
    const client = this.client;

    return {
      run(
        input: AsyncIterable<AgentClientMessage>,
        options?: { signal?: AbortSignal; headers?: Record<string, string> },
      ): AsyncIterable<AgentServerMessage> {
        const response = client.run(input, {
          ...(options?.headers ? { headers: options.headers } : {}),
        });

        if (!options?.signal) {
          return response;
        }

        return wrapAbortSafeStream(response, options.signal);
      },
    };
  }
}

export default AgentService;
