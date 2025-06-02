import { countTokens } from "../../llm/countTokens";
import { SnippetPayload } from "../snippets";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippet,
} from "../snippets/types";
import { HelperVars } from "../util/HelperVars";

import { isValidSnippet } from "./validation";

const getRemainingTokenCount = (helper: HelperVars): number => {
  const tokenCount = countTokens(helper.prunedCaretWindow, helper.modelName);

  return helper.options.maxPromptTokens - tokenCount;
};

const TOKEN_BUFFER = 10; // We may need extra tokens for snippet description etc.

/**
 * 배열을 무작위로 섞는 함수입니다.
 * @param array - 섞을 배열
 * @returns 무작위로 섞인 배열
 */
const shuffleArray = <T>(array: T[]): T[] => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

/**
 * 필터링된 스니펫이 현재 커서 위치의 윈도우에 이미 포함되어 있는지 확인합니다.
 * @param snippets - AutocompleteCodeSnippet 배열
 * @param caretWindow - 현재 커서 위치의 윈도우 문자열
 * @returns 필터링된 AutocompleteCodeSnippet 배열
 */
function filterSnippetsAlreadyInCaretWindow(
  snippets: AutocompleteCodeSnippet[],
  caretWindow: string,
): AutocompleteCodeSnippet[] {
  return snippets.filter(
    (s) => s.content.trim() !== "" && !caretWindow.includes(s.content.trim()),
  );
}
/**
 * 주어진 helper 변수와 payload를 기반으로 스니펫을 가져오고 필터링합니다.
 * 다양한 소스의 스니펫을 우선순위에 따라 정렬하고, 토큰 제한 내에 맞게 반환합니다.
 * @param helper - 컨텍스트와 옵션을 담고 있는 helper 변수.
 * @param payload - 여러 종류의 스니펫을 포함하는 payload.
 * @returns 필터링되고 우선순위가 적용된 AutocompleteSnippet 객체 배열.
 */
export const getSnippets = (
  helper: HelperVars,
  payload: SnippetPayload,
): AutocompleteSnippet[] => {
  const snippets = {
    clipboard: payload.clipboardSnippets,
    recentlyVisitedRanges: payload.recentlyVisitedRangesSnippets,
    recentlyEditedRanges: payload.recentlyEditedRangeSnippets,
    diff: payload.diffSnippets,
    base: shuffleArray(
      filterSnippetsAlreadyInCaretWindow(
        [...payload.rootPathSnippets, ...payload.importDefinitionSnippets],
        helper.prunedCaretWindow,
      ),
    ),
  };

  // Define snippets with their priorities
  const snippetConfigs: {
    key: keyof typeof snippets;
    enabledOrPriority: boolean | number;
    defaultPriority: number;
    snippets: AutocompleteSnippet[];
  }[] = [
    {
      key: "clipboard",
      enabledOrPriority: helper.options.experimental_includeClipboard,
      defaultPriority: 1,
      snippets: payload.clipboardSnippets,
    },
    {
      key: "recentlyVisitedRanges",
      enabledOrPriority:
        helper.options.experimental_includeRecentlyVisitedRanges,
      defaultPriority: 2,
      snippets: payload.recentlyVisitedRangesSnippets,
      /* TODO: recentlyVisitedRanges also contain contents from other windows like terminal or output
      if they are visible. We should handle them separately so that we can control their priority
      and whether they should be included or not. */
    },
    {
      key: "recentlyEditedRanges",
      enabledOrPriority:
        helper.options.experimental_includeRecentlyEditedRanges,
      defaultPriority: 3,
      snippets: payload.recentlyEditedRangeSnippets,
    },
    {
      key: "diff",
      enabledOrPriority: helper.options.experimental_includeDiff,
      defaultPriority: 4,
      snippets: payload.diffSnippets,
      // TODO: diff is commonly too large, thus anything lower in priority is not included.
    },
    {
      key: "base",
      enabledOrPriority: true,
      defaultPriority: 99, // make sure it's the last one to be processed, but still possible to override
      snippets: shuffleArray(
        filterSnippetsAlreadyInCaretWindow(
          [...payload.rootPathSnippets, ...payload.importDefinitionSnippets],
          helper.prunedCaretWindow,
        ),
      ),
      // TODO: Add this too to experimental config, maybe move upper in the order, since it's almost
      // always not inlucded due to diff being commonly large
    },
  ];

  // Create a readable order of enabled snippets
  const snippetOrder = snippetConfigs
    .filter(({ enabledOrPriority }) => enabledOrPriority)
    .map(({ key, enabledOrPriority, defaultPriority }) => ({
      key,
      priority:
        typeof enabledOrPriority === "number"
          ? enabledOrPriority
          : defaultPriority,
    }))
    .sort((a, b) => a.priority - b.priority);

  // Log the snippet order for debugging - uncomment if needed
  /* console.log(
    'Snippet processing order:',
    snippetOrder
      .map(({ key, priority }) => `${key} (priority: ${priority})`).join("\n")
  ); */

  // Convert configs to prioritized snippets
  let prioritizedSnippets = snippetOrder
    .flatMap(({ key, priority }) =>
      snippets[key].map((snippet) => ({ snippet, priority })),
    )
    .sort((a, b) => a.priority - b.priority)
    .map(({ snippet }) => snippet);

  // Exclude Continue's own output as it makes it super-hard for users to test the autocomplete feature
  // while looking at the prompts in the Continue's output
  prioritizedSnippets = prioritizedSnippets.filter(
    (snippet) =>
      !(snippet as AutocompleteCodeSnippet).filepath?.startsWith(
        "output:extension-output-Continue.continue",
      ),
  );

  const finalSnippets = [];
  let remainingTokenCount = getRemainingTokenCount(helper);

  while (remainingTokenCount > 0 && prioritizedSnippets.length > 0) {
    const snippet = prioritizedSnippets.shift();
    if (!snippet || !isValidSnippet(snippet)) {
      continue;
    }

    const snippetSize =
      countTokens(snippet.content, helper.modelName) + TOKEN_BUFFER;

    if (remainingTokenCount >= snippetSize) {
      finalSnippets.push(snippet);
      remainingTokenCount -= snippetSize;
    }
  }

  return finalSnippets;
};
