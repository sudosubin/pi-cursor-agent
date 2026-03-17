import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@connectrpc/connect";
import type {
  AgentClientMessage,
  AgentServerMessage,
} from "../../src/__generated__/agent/v1/agent_pb.js";
import type { AgentService as AgentServiceDef } from "../../src/__generated__/agent/v1/agent_service_connect.js";
import AgentService, {
  wrapAbortSafeStream,
} from "../../src/api/agent-service.js";

function createNeverEndingStream(returnSpy?: {
  called: boolean;
}): AsyncIterable<AgentServerMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise<IteratorResult<AgentServerMessage>>(() => {});
        },
        async return() {
          if (returnSpy) {
            returnSpy.called = true;
          }
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

test("wrapAbortSafeStream aborts by closing the underlying iterator", async () => {
  const controller = new AbortController();
  const returnSpy = { called: false };
  const stream = wrapAbortSafeStream(
    createNeverEndingStream(returnSpy),
    controller.signal,
  );

  const iterator = stream[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  controller.abort();

  await assert.rejects(nextPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(returnSpy.called, true);
});

test("rpcClient strips transport signal and still aborts the response stream", async () => {
  const controller = new AbortController();
  const returnSpy = { called: false };
  let seenOptions:
    | { signal?: AbortSignal; headers?: Record<string, string> }
    | undefined;

  const client = {
    run(
      _input: AsyncIterable<AgentClientMessage>,
      options?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): AsyncIterable<AgentServerMessage> {
      seenOptions = options;
      return createNeverEndingStream(returnSpy);
    },
  } as Client<typeof AgentServiceDef>;

  const service = Object.create(AgentService.prototype) as AgentService;
  Reflect.set(service as object, "client", client);

  const stream = service.rpcClient.run(
    {
      async *[Symbol.asyncIterator]() {},
    },
    { signal: controller.signal, headers: { "x-test": "1" } },
  );

  const iterator = stream[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  controller.abort();

  await assert.rejects(nextPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });

  assert.deepEqual(seenOptions, { headers: { "x-test": "1" } });
  assert.equal(returnSpy.called, true);
});
