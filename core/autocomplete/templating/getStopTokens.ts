import { CompletionOptions } from "../..";
import { AutocompleteLanguageInfo } from "../constants/AutocompleteLanguageInfo";

const DOUBLE_NEWLINE = "\n\n";
const WINDOWS_DOUBLE_NEWLINE = "\r\n\r\n";
// TODO: Do we want to stop completions when reaching a `/src/` string?
const SRC_DIRECTORY = "/src/";
// Starcoder2 tends to output artifacts starting with the letter "t"
const STARCODER2_T_ARTIFACTS = ["t.", "\nt", "<file_sep>"];
const PYTHON_ENCODING = "#- coding: utf-8";
const CODE_BLOCK_END = "```";

// const multilineStops: string[] = [DOUBLE_NEWLINE, WINDOWS_DOUBLE_NEWLINE];
const commonStops = [SRC_DIRECTORY, PYTHON_ENCODING, CODE_BLOCK_END];

/**
 * 주어진 completionOptions와 언어 정보, 모델 이름을 사용하여 중지 토큰을 반환합니다.
 * stop 옵션이 제공된 경우 해당 옵션을 우선 사용하고, 그 외에 공통 중지 토큰과 언어별 키워드를 추가합니다.
 */
export function getStopTokens(
  completionOptions: Partial<CompletionOptions> | undefined,
  lang: AutocompleteLanguageInfo,
  model: string,
): string[] {
  const stopTokens = [
    ...(completionOptions?.stop || []),
    // ...multilineStops,
    ...commonStops,
    ...(model.toLowerCase().includes("starcoder2")
      ? STARCODER2_T_ARTIFACTS
      : []),
    // ...lang.topLevelKeywords.map((word) => `\n${word}`),
  ];

  return stopTokens;
}
