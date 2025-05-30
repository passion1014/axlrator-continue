import { RangeInFileWithContents } from "../../../";
import { countTokens } from "../../../llm/countTokens";
import { AutocompleteSnippetDeprecated } from "../../types";
import { HelperVars } from "../../util/HelperVars";

const rx = /[\s.,\/#!$%\^&\*;:{}=\-_`~()\[\]]/g;

/**
 * 코드 스니펫에서 고유한 심볼을 추출합니다.
 * 심볼은 공백 또는 구두점으로 구분된 비어있지 않은 문자열로 정의됩니다.
 * 이는 코드 스니펫 간의 자카드 유사도를 계산하는 데 사용됩니다.
 *
 * @param snippet - 심볼을 추출할 코드 스니펫
 * @returns 스니펫에서 발견된 고유 심볼의 집합(Set)
 */
export function getSymbolsForSnippet(snippet: string): Set<string> {
  const symbols = snippet
    .split(rx)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return new Set(symbols);
}

/**
 * 두 문자열의 공유 심볼 개수를 전체 고유 심볼 개수로 나눈 값으로 유사도를 계산합니다.
 */
function jaccardSimilarity(a: string, b: string): number {
  const aSet = getSymbolsForSnippet(a);
  const bSet = getSymbolsForSnippet(b);
  const union = new Set([...aSet, ...bSet]).size;

  // 0으로 나누는 것을 방지
  if (union === 0) {
    return 0;
  }

  let intersection = 0;
  for (const symbol of aSet) {
    if (bSet.has(symbol)) {
      intersection++;
    }
  }

  return intersection / union;
}

/**
 * 탭 자동완성 프롬프트에 사용할 코드 스니펫을 순위별로 정렬합니다. 정렬된 스니펫 배열을 반환합니다.
 */
export function rankAndOrderSnippets(
  ranges: AutocompleteSnippetDeprecated[],
  helper: HelperVars,
): Required<AutocompleteSnippetDeprecated>[] {
  const windowAroundCursor =
    helper.fullPrefix.slice(
      -helper.options.slidingWindowSize *
        helper.options.slidingWindowPrefixPercentage,
    ) +
    helper.fullSuffix.slice(
      helper.options.slidingWindowSize *
        (1 - helper.options.slidingWindowPrefixPercentage),
    );

  const snippets: Required<AutocompleteSnippetDeprecated>[] = ranges.map(
    (snippet) => ({
      score:
        snippet.score ??
        jaccardSimilarity(snippet.contents, windowAroundCursor),
      ...snippet,
    }),
  );
  const uniqueSnippets = deduplicateSnippets(snippets);
  return uniqueSnippets.sort((a, b) => a.score - b.score);
}

/**
 * 겹치는 범위를 하나의 범위로 병합하여 코드 스니펫을 중복 제거합니다.
 */
function deduplicateSnippets(
  snippets: Required<AutocompleteSnippetDeprecated>[],
): Required<AutocompleteSnippetDeprecated>[] {
  // 파일별로 그룹화
  const fileGroups: {
    [key: string]: Required<AutocompleteSnippetDeprecated>[];
  } = {};
  for (const snippet of snippets) {
    if (!fileGroups[snippet.filepath]) {
      fileGroups[snippet.filepath] = [];
    }
    fileGroups[snippet.filepath].push(snippet);
  }

  // 겹치는 범위 병합
  const allRanges = [];
  for (const file of Object.keys(fileGroups)) {
    allRanges.push(...mergeSnippetsByRange(fileGroups[file]));
  }
  return allRanges;
}

/**
 * 범위에 따라 스니펫을 병합하며, 겹치거나 인접한 스니펫을 하나로 합칩니다.
 * 이는 코드에서 가까운 위치의 스니펫을 순위 매기기 및 중복 제거 시 하나의 스니펫으로 취급하기 위해 사용됩니다.
 */
function mergeSnippetsByRange(
  snippets: Required<AutocompleteSnippetDeprecated>[],
): Required<AutocompleteSnippetDeprecated>[] {
  if (snippets.length <= 1) {
    return snippets;
  }

  const sorted = snippets.sort(
    (a, b) => a.range.start.line - b.range.start.line,
  );
  const merged: Required<AutocompleteSnippetDeprecated>[] = [];

  while (sorted.length > 0) {
    const next = sorted.shift()!;
    const last = merged[merged.length - 1];
    if (merged.length > 0 && last.range.end.line >= next.range.start.line) {
      // 이전 스니펫과 병합
      last.score = Math.max(last.score, next.score);
      try {
        last.range.end = next.range.end;
      } catch (e) {
        console.log("Error merging ranges", e);
      }
      last.contents = mergeOverlappingRangeContents(last, next);
    } else {
      merged.push(next);
    }
  }

  return merged;
}

/**
 * 겹치는 두 범위의 내용을 병합합니다.
 * 이는 코드에서 겹치는 두 스니펫의 내용을 합치기 위해 사용됩니다.
 */
function mergeOverlappingRangeContents(
  first: RangeInFileWithContents,
  second: RangeInFileWithContents,
): string {
  const firstLines = first.contents.split("\n");
  const numOverlapping = first.range.end.line - second.range.start.line;
  return `${firstLines.slice(-numOverlapping).join("\n")}\n${second.contents}`;
}

/**
 * 허용된 공간 내에 스니펫을 채웁니다.
 * 스니펫은 점수 순으로 정렬되어 있다고 가정합니다.
 */
export function fillPromptWithSnippets(
  snippets: Required<AutocompleteSnippetDeprecated>[],
  maxSnippetTokens: number,
  modelName: string,
): Required<AutocompleteSnippetDeprecated>[] {
  let tokensRemaining = maxSnippetTokens;
  const keptSnippets: Required<AutocompleteSnippetDeprecated>[] = [];
  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i];
    const tokenCount = countTokens(snippet.contents, modelName);
    if (tokensRemaining - tokenCount >= 0) {
      tokensRemaining -= tokenCount;
      keptSnippets.push(snippet);
    } else {
    }
  }

  return keptSnippets;
}
