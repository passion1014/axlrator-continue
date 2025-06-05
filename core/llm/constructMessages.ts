import {
  ChatHistoryItem,
  ChatMessage,
  ContextItemWithId,
  RuleWithSource,
  TextMessagePart,
  ToolResultChatMessage,
  UserChatMessage,
} from "../";
import { findLast } from "../util/findLast";
import { normalizeToMessageParts } from "../util/messageContent";
import { isUserOrToolMsg } from "./messages";
import { getSystemMessageWithRules } from "./rules/getSystemMessageWithRules";

export const DEFAULT_CHAT_SYSTEM_MESSAGE_URL =
  "https://github.com/continuedev/continue/blob/main/core/llm/constructMessages.ts";

export const DEFAULT_AGENT_SYSTEM_MESSAGE_URL =
  "https://github.com/continuedev/continue/blob/main/core/llm/constructMessages.ts";

const EDIT_MESSAGE = `\
  Always include the language and file name in the info string when you write code blocks.
  If you are editing "src/main.py" for example, your code block should start with '\`\`\`python src/main.py'

  When addressing code modification requests, present a concise code snippet that
  emphasizes only the necessary changes and uses abbreviated placeholders for
  unmodified sections. For example:

  \`\`\`language /path/to/file
  // ... existing code ...

  {{ modified code here }}

  // ... existing code ...

  {{ another modification }}

  // ... rest of code ...
  \`\`\`

  In existing files, you should always restate the function or class that the snippet belongs to:

  \`\`\`language /path/to/file
  // ... existing code ...

  function exampleFunction() {
    // ... existing code ...

    {{ modified code here }}

    // ... rest of function ...
  }

  // ... rest of code ...
  \`\`\`

  Since users have access to their complete file, they prefer reading only the
  relevant modifications. It's perfectly acceptable to omit unmodified portions
  at the beginning, middle, or end of files using these "lazy" comments. Only
  provide the complete file when explicitly requested. Include a concise explanation
  of changes unless the user specifically asks for code only.
`;

export const DEFAULT_CHAT_SYSTEM_MESSAGE = `\
<important_rules>
  You are in chat mode.

  If the user asks to make changes to files offer that they can use the Apply Button on the code block, or switch to Agent Mode to make the suggested updates automatically.
  If needed consisely explain to the user they can switch to agent mode using the Mode Selector dropdown and provide no other details.

${EDIT_MESSAGE}
</important_rules>`;

export const DEFAULT_AGENT_SYSTEM_MESSAGE = `\
<important_rules>
  You are in agent mode.

${EDIT_MESSAGE}
</important_rules>`;

/**
 * 사용자 메시지에 대한 컨텍스트 아이템을 가져오는 헬퍼 함수
 */
function getUserContextItems(
  userMsg: UserChatMessage | ToolResultChatMessage | undefined,
  history: ChatHistoryItem[],
): ContextItemWithId[] {
  if (!userMsg) return [];

  // userMsg를 포함하는 히스토리 아이템을 찾음
  const historyItem = history.find((item) => {
    // 메시지 ID가 일치하는지 확인
    if ("id" in userMsg && "id" in item.message) {
      return (item.message as any).id === (userMsg as any).id;
    }
    // ID가 없으면 content로 비교
    return (
      item.message.content === userMsg.content &&
      item.message.role === userMsg.role
    );
  });

  return historyItem?.contextItems || [];
}

/**
 * 주어진 히스토리, 기본 시스템 메시지, 규칙을 바탕으로 채팅 메시지를 생성
 * 메시지 모드에 따라 시스템 메시지와 툴 호출을 필터링
 *
 * @param messageMode - The mode of the chat (e.g., "chat" or "agent").
 * @param history - The chat history items to construct messages from.
 * @param baseChatOrAgentSystemMessage - The base system message for the chat or agent.
 * @param rules - The rules to apply to the system message.
 * @returns An array of constructed chat messages.
 */
export function constructMessages(
  messageMode: string,
  history: ChatHistoryItem[],
  baseChatOrAgentSystemMessage: string | undefined,
  rules: RuleWithSource[],
): ChatMessage[] {
  const filteredHistory = history.filter(
    (item) => item.message.role !== "system",
  );
  const msgs: ChatMessage[] = [];

  for (let i = 0; i < filteredHistory.length; i++) {
    const historyItem = filteredHistory[i];

    if (messageMode === "chat") {
      const toolMessage: ToolResultChatMessage =
        historyItem.message as ToolResultChatMessage;
      if (historyItem.toolCallState?.toolCallId || toolMessage.toolCallId) {
        // 히스토리에서 모든 툴 호출 제거
        continue;
      }
    }

    if (historyItem.message.role === "user") {
      // 사용자 메시지에 대한 컨텍스트 아이템 수집
      let content = normalizeToMessageParts(historyItem.message);

      const ctxItems = historyItem.contextItems
        .map((ctxItem) => {
          return {
            type: "text",
            text: `${ctxItem.content}\n`,
          } as TextMessagePart;
        })
        .filter((part) => !!part.text.trim());

      content = [...ctxItems, ...content];
      msgs.push({
        ...historyItem.message,
        content,
      });
    } else {
      msgs.push(historyItem.message);
    }
  }

  const lastUserMsg = findLast(msgs, isUserOrToolMsg) as
    | UserChatMessage
    | ToolResultChatMessage
    | undefined;

  // 마지막 사용자 메시지에 대한 컨텍스트 아이템 가져오기
  const lastUserContextItems = getUserContextItems(
    lastUserMsg,
    filteredHistory,
  );
  const systemMessage = getSystemMessageWithRules({
    baseSystemMessage: baseChatOrAgentSystemMessage,
    rules,
    userMessage: lastUserMsg,
    contextItems: lastUserContextItems,
  });

  if (systemMessage.trim()) {
    msgs.unshift({
      role: "system",
      content: systemMessage,
    });
  }

  // 모든 메시지에서 "id" 제거
  return msgs.map((msg) => {
    const { id, ...rest } = msg as any;
    return rest;
  });
}
