import { IDE } from "../..";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippetType,
} from "../snippets/types";
import { HelperVars } from "../util/HelperVars";

import { ImportDefinitionsService } from "./ImportDefinitionsService";
import { getSymbolsForSnippet } from "./ranking";
import { RootPathContextService } from "./root-path-context/RootPathContextService";

/**
 * ContextRetrievalService는 현재 파일의 import 정의와 루트 경로에 대한 코드 스니펫을 가져오는 서비스입니다.
 * 이 서비스는 IDE 인스턴스를 사용하여 import 정의와 루트 경로 컨텍스트를 관리합니다.
 */
export class ContextRetrievalService {
  private importDefinitionsService: ImportDefinitionsService;
  private rootPathContextService: RootPathContextService;

  constructor(private readonly ide: IDE) {
    this.importDefinitionsService = new ImportDefinitionsService(this.ide);
    this.rootPathContextService = new RootPathContextService(
      this.importDefinitionsService,
      this.ide,
    );
  }

  /**
   * 현재 파일의 import 정의에서 코드 스니펫을 가져옵니다.
   * @param helper - 헬퍼 변수로, 현재 파일 경로와 옵션을 포함합니다.
   * @returns import 정의에서 가져온 코드 스니펫 배열
   */
  public async getSnippetsFromImportDefinitions(
    helper: HelperVars,
  ): Promise<AutocompleteCodeSnippet[]> {
    if (helper.options.useImports === false) {
      return [];
    }

    const importSnippets: AutocompleteCodeSnippet[] = [];
    const fileInfo = this.importDefinitionsService.get(helper.filepath);
    if (fileInfo) {
      const { imports } = fileInfo;
      // Look for imports of any symbols around the current range
      const textAroundCursor =
        helper.fullPrefix.split("\n").slice(-5).join("\n") +
        helper.fullSuffix.split("\n").slice(0, 3).join("\n");
      const symbols = Array.from(getSymbolsForSnippet(textAroundCursor)).filter(
        (symbol) => !helper.lang.topLevelKeywords.includes(symbol),
      );
      for (const symbol of symbols) {
        const rifs = imports[symbol];
        if (Array.isArray(rifs)) {
          const snippets: AutocompleteCodeSnippet[] = rifs.map((rif) => {
            return {
              filepath: rif.filepath,
              content: rif.contents,
              type: AutocompleteSnippetType.Code,
            };
          });

          importSnippets.push(...snippets);
        }
      }
    }

    return importSnippets;
  }

  /**
   * 현재 파일의 루트 경로에 대한 코드 스니펫을 가져옵니다.
   * @param helper - 헬퍼 변수로, 현재 파일 경로와 트리 경로를 포함합니다.
   * @returns 루트 경로에 대한 코드 스니펫 배열
   */
  public async getRootPathSnippets(
    helper: HelperVars,
  ): Promise<AutocompleteCodeSnippet[]> {
    if (!helper.treePath) {
      return [];
    }

    return this.rootPathContextService.getContextForPath(
      helper.filepath,
      helper.treePath,
    );
  }
}
