import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentClientMessage,
  AgentRunRequest,
  AgentServerMessage,
  ConversationAction,
  ConversationStateStructure,
  InteractionUpdate,
  UserMessage,
  UserMessageAction,
  UserMessageAppendedUpdate,
} from "../../../src/__generated__/agent/v1/agent_pb.js";
import {
  AgentConnectClient,
  type AgentRpcClient,
} from "../../../src/vendor/agent-client/connect.js";
import { LostConnection } from "../../../src/vendor/agent-client/exec-controller.js";
import { InMemoryBlobStore } from "../../../src/vendor/agent-kv/index.js";

function userAction(text: string): ConversationAction {
  return new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({
        userMessage: new UserMessage({ text, messageId: crypto.randomUUID() }),
      }),
    },
  });
}

function getUserMessage(action: ConversationAction): UserMessage {
  assert.equal(action.action.case, "userMessageAction");
  if (action.action.case !== "userMessageAction") {
    assert.fail("Expected a user message action");
  }
  const message = action.action.value.userMessage;
  assert.ok(message);
  return message;
}

function getConversationAction(
  message: AgentClientMessage,
): ConversationAction {
  assert.equal(message.message.case, "conversationAction");
  if (message.message.case !== "conversationAction") {
    assert.fail("Expected a conversation action");
  }
  return message.message.value;
}

function appendedMessage(userMessage: UserMessage): AgentServerMessage {
  return new AgentServerMessage({
    message: {
      case: "interactionUpdate",
      value: new InteractionUpdate({
        message: {
          case: "userMessageAppended",
          value: new UserMessageAppendedUpdate({ userMessage }),
        },
      }),
    },
  });
}

function createRunOptions() {
  let latestCheckpoint: ConversationStateStructure | undefined;
  return {
    interactionListener: {
      async sendUpdate() {},
      async query() {
        return { approved: false, reason: "Not supported" };
      },
    },
    resources: { entries: () => [] },
    blobStore: new InMemoryBlobStore(),
    checkpointHandler: {
      async handleCheckpoint(
        _ctx: unknown,
        checkpoint: ConversationStateStructure,
      ) {
        latestCheckpoint = checkpoint;
      },
      getLatestCheckpoint: () => latestCheckpoint,
    },
  };
}

function initialRequest(): AgentClientMessage {
  return new AgentClientMessage({
    message: {
      case: "runRequest",
      value: new AgentRunRequest({ action: userAction("start") }),
    },
  });
}

test("sends multiple conversation actions in order over an active run", async () => {
  const received: AgentClientMessage[] = [];
  const rpcClient: AgentRpcClient = {
    run(input) {
      return (async function* () {
        for await (const message of input) {
          received.push(message);
          if (message.message.case !== "conversationAction") continue;
          yield appendedMessage(getUserMessage(message.message.value));
          if (
            received.filter(
              (item) => item.message.case === "conversationAction",
            ).length === 2
          ) {
            return;
          }
        }
      })();
    },
  };

  const client = new AgentConnectClient(rpcClient);
  const runPromise = client.run(initialRequest(), createRunOptions());
  await client.sendConversationActions([
    userAction("slow down"),
    userAction("stop"),
  ]);
  await runPromise;

  assert.deepEqual(
    received.map((message) => message.message.case),
    ["runRequest", "conversationAction", "conversationAction"],
  );
  assert.deepEqual(
    received
      .slice(1)
      .map((message) => getUserMessage(getConversationAction(message)).text),
    ["slow down", "stop"],
  );
});

test("keeps replaying the same action id across clean stream closures", async () => {
  const action = userAction("stop");
  const expectedMessageId = getUserMessage(action).messageId;
  const receivedMessageIds: string[] = [];
  let attempt = 0;

  const client = new AgentConnectClient({
    run(input) {
      attempt += 1;
      const currentAttempt = attempt;
      return (async function* () {
        for await (const message of input) {
          if (message.message.case === "conversationAction") {
            const userMessage = getUserMessage(message.message.value);
            receivedMessageIds.push(userMessage.messageId);
            yield new AgentServerMessage({
              message: {
                case: "conversationCheckpointUpdate",
                value: new ConversationStateStructure({
                  rootPromptMessagesJson: [new Uint8Array([1])],
                }),
              },
            });
            return;
          }

          if (
            currentAttempt >= 2 &&
            message.message.case === "runRequest" &&
            message.message.value.action
          ) {
            const userMessage = getUserMessage(message.message.value.action);
            receivedMessageIds.push(userMessage.messageId);
            if (currentAttempt === 2) {
              yield new AgentServerMessage({
                message: {
                  case: "conversationCheckpointUpdate",
                  value: new ConversationStateStructure({
                    rootPromptMessagesJson: [new Uint8Array([2])],
                  }),
                },
              });
              return;
            }
            yield appendedMessage(userMessage);
            return;
          }
        }
      })();
    },
  });

  const runPromise = client.run(initialRequest(), createRunOptions());
  await client.sendConversationAction(action);
  await runPromise;

  assert.equal(attempt, 3);
  assert.deepEqual(receivedMessageIds, [
    expectedMessageId,
    expectedMessageId,
    expectedMessageId,
  ]);
});

test("replays pending actions after a transport retry", async () => {
  const action = userAction("stop");
  const expectedMessageId = getUserMessage(action).messageId;
  const receivedMessageIds: string[] = [];
  let attempt = 0;

  const client = new AgentConnectClient({
    run(input) {
      attempt += 1;
      const currentAttempt = attempt;
      return (async function* () {
        for await (const message of input) {
          if (message.message.case !== "conversationAction") continue;
          const userMessage = getUserMessage(message.message.value);
          receivedMessageIds.push(userMessage.messageId);
          if (currentAttempt === 1) {
            throw new LostConnection("test disconnect");
          }
          yield appendedMessage(userMessage);
          return;
        }
      })();
    },
  });

  const runPromise = client.run(initialRequest(), createRunOptions());
  await client.sendConversationAction(action);
  await runPromise;

  assert.equal(attempt, 2);
  assert.deepEqual(receivedMessageIds, [expectedMessageId, expectedMessageId]);
});

test("rejects conversation actions when no run is active", async () => {
  const client = new AgentConnectClient({
    run() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });

  await assert.rejects(
    client.sendConversationAction(userAction("stop")),
    /not accepting new actions/,
  );
});
