import { createHash } from "crypto";

import { LRUCache } from "lru-cache";
import Parser from "web-tree-sitter";

import { IDE } from "../../..";
import {
  getFullLanguageName,
  getQueryForFile,
  IGNORE_PATH_PATTERNS,
  LanguageName,
} from "../../../util/treeSitter";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippetType,
} from "../../snippets/types";
import { AutocompleteSnippetDeprecated } from "../../types";
import { AstPath } from "../../util/ast";
import { ImportDefinitionsService } from "../ImportDefinitionsService";

// function getSyntaxTreeString(
//   node: Parser.SyntaxNode,
//   indent: string = "",
// ): string {
//   let result = "";
//   const nodeInfo = `${node.type} [${node.startPosition.row}:${node.startPosition.column} - ${node.endPosition.row}:${node.endPosition.column}]`;
//   result += `${indent}${nodeInfo}\n`;

//   for (const child of node.children) {
//     result += getSyntaxTreeString(child, indent + "  ");
//   }

//   return result;
// }

/**
 * RootPathContextService는 주어진 파일 경로와 AST 경로를 기반으로
 * 루트 경로 컨텍스트에 대한 코드 스니펫을 가져오는 서비스입니다.
 */
export class RootPathContextService {
  private cache = new LRUCache<string, AutocompleteSnippetDeprecated[]>({
    max: 100,
  });

  constructor(
    private readonly importDefinitionsService: ImportDefinitionsService,
    private readonly ide: IDE,
  ) {}

  /**
   * 주어진 AST 노드의 ID를 반환합니다.
   * 노드의 시작 인덱스를 사용하여 고유한 ID를 생성합니다.
   */
  private static getNodeId(node: Parser.SyntaxNode): string {
    return `${node.startIndex}`;
  }

  /**
   * 사용할 노드 타입을 정의합니다.
   * 이 타입들은 루트 경로 컨텍스트에서 스니펫을 가져오는 데 사용됩니다.
   */
  private static TYPES_TO_USE = new Set([
    "arrow_function",
    "generator_function_declaration",
    "program",
    "function_declaration",
    "function_definition",
    "method_definition",
    "method_declaration",
    "class_declaration",
    "class_definition",
  ]);

  /**
   * Key comes from hash of parent key and node type and node id.
   */
  private static keyFromNode(
    parentKey: string,
    astNode: Parser.SyntaxNode,
  ): string {
    return createHash("sha256")
      .update(parentKey)
      .update(astNode.type)
      .update(RootPathContextService.getNodeId(astNode))
      .digest("hex");
  }

  /**
   * 주어진 파일 경로와 AST 노드를 기반으로 스니펫을 가져옵니다.
   * 노드의 타입에 따라 적절한 쿼리를 사용하여 스니펫을 검색합니다.
   */
  private async getSnippetsForNode(
    filepath: string,
    node: Parser.SyntaxNode,
  ): Promise<AutocompleteSnippetDeprecated[]> {
    const snippets: AutocompleteSnippetDeprecated[] = [];
    const language = getFullLanguageName(filepath);

    let query: Parser.Query | undefined;
    switch (node.type) {
      case "program":
        this.importDefinitionsService.get(filepath);
        break;
      default:
        // const type = node.type;
        // console.log(getSyntaxTreeString(node));

        query = await getQueryForFile(
          filepath,
          `root-path-context-queries/${language}/${node.type}.scm`,
        );
        break;
    }

    if (!query) {
      return snippets;
    }

    const queries = query.matches(node).map(async (match) => {
      for (const item of match.captures) {
        try {
          const endPosition = item.node.endPosition;
          const newSnippets = await this.getSnippets(
            filepath,
            endPosition,
            language,
          );
          snippets.push(...newSnippets);
        } catch (e) {
          throw e;
        }
      }
    });

    await Promise.all(queries);

    return snippets;
  }

  /**
   * 주어진 파일 경로와 끝 위치를 기반으로 스니펫을 가져옵니다.
   * IDE의 gotoDefinition 메서드를 사용하여 정의를 찾고, 해당 정의의 내용을 읽어 스니펫을 생성합니다.
   */
  private async getSnippets(
    filepath: string,
    endPosition: Parser.Point,
    language: LanguageName,
  ): Promise<AutocompleteSnippetDeprecated[]> {
    const definitions = await this.ide.gotoDefinition({
      filepath,
      position: {
        line: endPosition.row,
        character: endPosition.column,
      },
    });
    const newSnippets = await Promise.all(
      definitions
        .filter((definition) => {
          const isIgnoredPath = IGNORE_PATH_PATTERNS[language]?.some(
            (pattern) => pattern.test(definition.filepath),
          );

          return !isIgnoredPath;
        })
        .map(async (def) => ({
          ...def,
          contents: await this.ide.readRangeInFile(def.filepath, def.range),
        })),
    );

    return newSnippets;
  }

  /**
   * 주어진 파일 경로와 AST 경로를 기반으로 코드 스니펫을 가져옵니다.
   * AST 경로를 따라 필터링된 노드들을 순회하며 스니펫을 수집합니다.
   */
  async getContextForPath(
    filepath: string,
    astPath: AstPath,
    // cursorIndex: number,
  ): Promise<AutocompleteCodeSnippet[]> {
    const snippets: AutocompleteCodeSnippet[] = [];

    let parentKey = filepath;
    for (const astNode of astPath.filter(
      (node) => RootPathContextService.TYPES_TO_USE.has(node.type), //노드타입 필터링
    )) {
      const key = RootPathContextService.keyFromNode(parentKey, astNode);
      // const type = astNode.type;

      const foundInCache = this.cache.get(key);
      const newSnippets =
        foundInCache ?? (await this.getSnippetsForNode(filepath, astNode));

      const formattedSnippets: AutocompleteCodeSnippet[] = newSnippets.map(
        (item) => ({
          filepath: item.filepath,
          content: item.contents,
          type: AutocompleteSnippetType.Code,
        }),
      );

      snippets.push(...formattedSnippets);

      if (!foundInCache) {
        this.cache.set(key, newSnippets);
      }

      parentKey = key;
    }

    return snippets;
  }
}
