import { AutocompleteLanguageInfo } from "../constants/AutocompleteLanguageInfo";
import { HelperVars } from "../util/HelperVars";

/**
 * 완성 결과가 중간 줄 완성인지 판단합니다.
 * 중간 줄 완성이란 줄 바꿈 문자로 시작하지 않는 완성입니다.
 * @param prefix - 현재 입력의 접두사입니다.
 * @param suffix - 현재 입력의 접미사입니다.
 * @returns {boolean} - 중간 줄 완성이면 true, 아니면 false를 반환합니다.
 */
function isMidlineCompletion(prefix: string, suffix: string): boolean {
  return !suffix.startsWith("\n");
}

/**
 * 언어와 컨텍스트에 따라 멀티라인 완성을 사용할지 결정합니다.
 * @param language - 자동완성을 위한 언어 정보입니다.
 * @param prefix - 현재 입력의 접두사입니다.
 * @param suffix - 현재 입력의 접미사입니다.
 * @returns {boolean} - 멀티라인 완성을 사용해야 하면 true, 아니면 false를 반환합니다.
 */
function shouldCompleteMultilineBasedOnLanguage(
  language: AutocompleteLanguageInfo,
  prefix: string,
  suffix: string,
) {
  return language.useMultiline?.({ prefix, suffix }) ?? true;
}

/**
 * 헬퍼 변수에 따라 멀티라인 완성을 사용할지 결정합니다.
 * @param helper - 컨텍스트와 옵션을 포함하는 헬퍼 변수입니다.
 * @returns {boolean} - 멀티라인 완성을 사용해야 하면 true, 아니면 false를 반환합니다.
 */
export function shouldCompleteMultiline(helper: HelperVars) {
  switch (helper.options.multilineCompletions) {
    case "always":
      return true;
    case "never":
      return false;
    default:
      break;
  }

  // 인텔리센스 옵션이 선택된 경우 항상 단일 줄 완성
  if (helper.input.selectedCompletionInfo) {
    return true;
  }

  // // 중간 줄에 있는 경우 멀티라인 완성하지 않음
  // if (isMidlineCompletion(helper.fullPrefix, helper.fullSuffix)) {
  //   return false;
  // }

  // 한 줄 주석에서는 멀티라인 완성하지 않음
  if (
    helper.lang.singleLineComment &&
    helper.fullPrefix
      .split("\n")
      .slice(-1)[0]
      ?.trimStart()
      .startsWith(helper.lang.singleLineComment)
  ) {
    return false;
  }

  return shouldCompleteMultilineBasedOnLanguage(
    helper.lang,
    helper.prunedPrefix,
    helper.prunedSuffix,
  );
}
