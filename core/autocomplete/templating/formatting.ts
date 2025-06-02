import { getLastNUriRelativePathParts } from "../../util/uri";
import {
  AutocompleteClipboardSnippet,
  AutocompleteCodeSnippet,
  AutocompleteDiffSnippet,
  AutocompleteSnippet,
  AutocompleteSnippetType,
} from "../snippets/types";
import { HelperVars } from "../util/HelperVars";

/**
 * 주어진 헬퍼 변수에서 주석 마크를 가져옵니다.
 * @param helper - 헬퍼 변수들
 * @returns 주석 마크 문자열
 */
const getCommentMark = (helper: HelperVars) => {
  return helper.lang.singleLineComment;
};

/**
 * 주어진 텍스트에 주석 마크를 추가합니다.
 * @param text - 주석을 추가할 텍스트
 * @param helper - 헬퍼 변수들
 * @returns 주석이 추가된 텍스트
 */
const addCommentMarks = (text: string, helper: HelperVars) => {
  const commentMark = getCommentMark(helper);
  return text
    .trim()
    .split("\n")
    .map((line) => `${commentMark} ${line}`)
    .join("\n");
};

/**
 * 주어진 스니펫을 형식화합니다.
 * @param snippet - AutocompleteClipboardSnippet 객체
 * @param workspaceDirs - 작업 공간 디렉토리 배열
 * @returns 형식화된 AutocompleteCodeSnippet 객체
 */
const formatClipboardSnippet = (
  snippet: AutocompleteClipboardSnippet,
  workspaceDirs: string[],
): AutocompleteCodeSnippet => {
  return formatCodeSnippet(
    {
      filepath: "file:///Untitled.txt",
      content: snippet.content,
      type: AutocompleteSnippetType.Code,
    },
    workspaceDirs,
  );
};

/**
 * 주어진 스니펫을 형식화합니다.
 * @param snippet - AutocompleteCodeSnippet 객체
 * @param workspaceDirs - 작업 공간 디렉토리 배열
 * @returns 형식화된 AutocompleteCodeSnippet 객체
 */
const formatCodeSnippet = (
  snippet: AutocompleteCodeSnippet,
  workspaceDirs: string[],
): AutocompleteCodeSnippet => {
  return {
    ...snippet,
    content: `Path: ${getLastNUriRelativePathParts(workspaceDirs, snippet.filepath, 2)}\n${snippet.content}`,
  };
};

/**
 * 주어진 스니펫을 형식화합니다.
 * @param snippet - AutocompleteDiffSnippet 객체
 * @returns 형식화된 AutocompleteDiffSnippet 객체
 */
const formatDiffSnippet = (
  snippet: AutocompleteDiffSnippet,
): AutocompleteDiffSnippet => {
  return snippet;
};

/**
 * 주어진 헬퍼 변수와 스니펫을 주석 처리합니다.
 * @param helper - 헬퍼 변수들
 * @param snippet - 주석 처리할 스니펫
 * @returns 주석 처리된 스니펫
 */
const commentifySnippet = (
  helper: HelperVars,
  snippet: AutocompleteSnippet,
): AutocompleteSnippet => {
  return {
    ...snippet,
    content: addCommentMarks(snippet.content, helper),
  };
};

/**
 * 주어진 헬퍼 변수와 스니펫 배열을 사용하여 스니펫을 형식화합니다.
 * @param helper - 헬퍼 변수들
 * @param snippets - AutocompleteSnippet 배열
 * @param workspaceDirs - 작업 공간 디렉토리 배열
 * @returns 형식화된 스니펫 문자열
 */
export const formatSnippets = (
  helper: HelperVars,
  snippets: AutocompleteSnippet[],
  workspaceDirs: string[],
): string => {
  const currentFilepathComment = addCommentMarks(
    getLastNUriRelativePathParts(workspaceDirs, helper.filepath, 2),
    helper,
  );

  return (
    snippets
      .map((snippet) => {
        switch (snippet.type) {
          case AutocompleteSnippetType.Code:
            return formatCodeSnippet(snippet, workspaceDirs);
          case AutocompleteSnippetType.Diff:
            return formatDiffSnippet(snippet);
          case AutocompleteSnippetType.Clipboard:
            return formatClipboardSnippet(snippet, workspaceDirs);
        }
      })
      .map((item) => {
        return commentifySnippet(helper, item).content;
      })
      .join("\n") + `\n${currentFilepathComment}`
  );
};
