import { IDE } from "../../index";
import { findUriInDirs } from "../../util/uri";
import { ContextRetrievalService } from "../context/ContextRetrievalService";
import { GetLspDefinitionsFunction } from "../types";
import { HelperVars } from "../util/HelperVars";

import {
  AutocompleteClipboardSnippet,
  AutocompleteCodeSnippet,
  AutocompleteDiffSnippet,
  AutocompleteSnippetType,
} from "./types";

const IDE_SNIPPETS_ENABLED = false; // ideSnippets is not used, so it's temporarily disabled

export interface SnippetPayload {
  rootPathSnippets: AutocompleteCodeSnippet[];
  importDefinitionSnippets: AutocompleteCodeSnippet[];
  ideSnippets: AutocompleteCodeSnippet[];
  recentlyEditedRangeSnippets: AutocompleteCodeSnippet[];
  recentlyVisitedRangesSnippets: AutocompleteCodeSnippet[];
  diffSnippets: AutocompleteDiffSnippet[];
  clipboardSnippets: AutocompleteClipboardSnippet[];
}

/**
 * 주어진 프로미스가 지정된 시간 내에 완료되지 않으면 빈 배열을 반환합니다.
 * @param promise
 * @returns
 */
function racePromise<T>(promise: Promise<T[]>): Promise<T[]> {
  const timeoutPromise = new Promise<T[]>((resolve) => {
    setTimeout(() => resolve([]), 100);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * DiffSnippetsCache 클래스는 diff 스니펫을 캐싱하여
 */
class DiffSnippetsCache {
  private cache: Map<number, any> = new Map();
  private lastTimestamp: number = 0;

  public set<T>(timestamp: number, value: T): T {
    // Clear old cache entry if exists
    if (this.lastTimestamp !== timestamp) {
      this.cache.clear();
    }
    this.lastTimestamp = timestamp;
    this.cache.set(timestamp, value);
    return value;
  }

  public get(timestamp: number): any | undefined {
    return this.cache.get(timestamp);
  }
}

const diffSnippetsCache = new DiffSnippetsCache();

// Some IDEs might have special ways of finding snippets (e.g. JetBrains and VS Code have different "LSP-equivalent" systems,
// or they might separately track recently edited ranges)
/**
 * 주어진 헬퍼 변수와 IDE 인스턴스를 사용하여 IDE 스니펫을 가져옵니다.
 * @param helper - 헬퍼 변수들
 * @param ide - IDE 인스턴스
 * @param getDefinitionsFromLsp - LSP에서 정의를 가져오는 함수
 * @returns AutocompleteCodeSnippet 배열
 */
async function getIdeSnippets(
  helper: HelperVars,
  ide: IDE,
  getDefinitionsFromLsp: GetLspDefinitionsFunction,
): Promise<AutocompleteCodeSnippet[]> {
  const ideSnippets = await getDefinitionsFromLsp(
    helper.input.filepath,
    helper.fullPrefix + helper.fullSuffix,
    helper.fullPrefix.length,
    ide,
    helper.lang,
  );

  if (helper.options.onlyMyCode) {
    const workspaceDirs = await ide.getWorkspaceDirs();

    return ideSnippets.filter((snippet) =>
      workspaceDirs.some(
        (dir) => !!findUriInDirs(snippet.filepath, [dir]).foundInDir,
      ),
    );
  }

  return ideSnippets;
}

/**
 * 최근에 편집된 범위에서 스니펫을 가져옵니다.
 * @param helper - 헬퍼 변수들
 * @returns 최근에 편집된 범위의 스니펫 배열
 */
function getSnippetsFromRecentlyEditedRanges(
  helper: HelperVars,
): AutocompleteCodeSnippet[] {
  if (helper.options.useRecentlyEdited === false) {
    return [];
  }

  return helper.input.recentlyEditedRanges.map((range) => {
    return {
      filepath: range.filepath,
      content: range.lines.join("\n"),
      type: AutocompleteSnippetType.Code,
    };
  });
}

/**
 * 주어진 IDE 인스턴스에서 클립보드 스니펫을 가져옵니다.
 * @param ide - IDE 인스턴스
 * @returns AutocompleteClipboardSnippet 배열
 */
const getClipboardSnippets = async (
  ide: IDE,
): Promise<AutocompleteClipboardSnippet[]> => {
  const content = await ide.getClipboardContent();

  return [content].map((item) => {
    return {
      content: item.text,
      copiedAt: item.copiedAt,
      type: AutocompleteSnippetType.Clipboard,
    };
  });
};

/**
 * 주어진 IDE 인스턴스에서 diff 스니펫을 가져옵니다.
 * @param ide
 * @returns
 */
const getDiffSnippets = async (
  ide: IDE,
): Promise<AutocompleteDiffSnippet[]> => {
  const currentTimestamp = ide.getLastFileSaveTimestamp
    ? ide.getLastFileSaveTimestamp()
    : Math.floor(Date.now() / 10000) * 10000; // Defaults to update once in every 10 seconds

  // Check cache first
  const cached = diffSnippetsCache.get(
    currentTimestamp,
  ) as AutocompleteDiffSnippet[];

  if (cached) {
    return cached;
  }

  let diff: string[] = [];
  try {
    diff = await ide.getDiff(true);
  } catch (e) {
    console.error("Error getting diff for autocomplete", e);
  }

  return diffSnippetsCache.set(
    currentTimestamp,
    diff.map((item) => {
      return {
        content: item,
        type: AutocompleteSnippetType.Diff,
      };
    }),
  );
};

/**
 * 모든 스니펫을 가져옵니다.
 * - 루트 경로 스니펫
 * - import 정의 스니펫
 * - IDE 스니펫
 * - 최근에 편집된 범위 스니펫
 * - diff 스니펫
 * - 클립보드 스니펫
 * @param helper - 헬퍼 변수들
 * @param ide - IDE 인스턴스
 * @param getDefinitionsFromLsp - LSP에서 정의를 가져오는 함수
 * @param contextRetrievalService - 컨텍스트 검색 서비스 인스턴스
 * @returns SnippetPayload 객체
 */
export const getAllSnippets = async ({
  helper,
  ide,
  getDefinitionsFromLsp,
  contextRetrievalService,
}: {
  helper: HelperVars;
  ide: IDE;
  getDefinitionsFromLsp: GetLspDefinitionsFunction;
  contextRetrievalService: ContextRetrievalService;
}): Promise<SnippetPayload> => {
  const recentlyEditedRangeSnippets =
    getSnippetsFromRecentlyEditedRanges(helper);

  const [
    rootPathSnippets,
    importDefinitionSnippets,
    ideSnippets,
    diffSnippets,
    clipboardSnippets,
  ] = await Promise.all([
    racePromise(contextRetrievalService.getRootPathSnippets(helper)),
    racePromise(
      contextRetrievalService.getSnippetsFromImportDefinitions(helper),
    ),
    IDE_SNIPPETS_ENABLED
      ? racePromise(getIdeSnippets(helper, ide, getDefinitionsFromLsp))
      : [],
    racePromise(getDiffSnippets(ide)),
    racePromise(getClipboardSnippets(ide)),
  ]);

  return {
    rootPathSnippets,
    importDefinitionSnippets,
    ideSnippets,
    recentlyEditedRangeSnippets,
    diffSnippets,
    clipboardSnippets,
    recentlyVisitedRangesSnippets: helper.input.recentlyVisitedRanges,
  };
};
