import type { CursorRule } from "../../__generated__/agent/v1/cursor_rules_pb";
import { parsePiSystemPrompt } from "./parser";
import { buildCursorRules } from "./rules-builder";

export interface PreparedPiContext {
  rules: CursorRule[];
  cleanedPrompt: string;
}

export async function preparePiContext(
  systemPrompt: string,
): Promise<PreparedPiContext> {
  const parsed = parsePiSystemPrompt(systemPrompt);
  const rules = await buildCursorRules(parsed);
  return { rules, cleanedPrompt: parsed.cleanedPrompt };
}
