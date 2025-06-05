import { SyntaxNode } from "web-tree-sitter";

import { ChunkWithoutID } from "../../index.js";
import { countTokensAsync } from "../../llm/countTokens.js";
import { getParserForFile } from "../../util/treeSitter.js";

/**
 * 주어진 노드를 축소된 표현으로 변환합니다.
 * @param node - 변환할 노드
 * @returns 축소된 표현
 */
function collapsedReplacement(node: SyntaxNode): string {
  if (node.type === "statement_block") {
    return "{ ... }";
  }
  return "...";
}

/**
 * 주어진 노드의 첫 번째 자식 노드를 반환합니다.
 * @param node - 부모 노드
 * @param grammarName - 찾을 자식 노드의 타입 또는 타입 배열
 * @returns 첫 번째 자식 노드 또는 null
 */
function firstChild(
  node: SyntaxNode,
  grammarName: string | string[],
): SyntaxNode | null {
  if (Array.isArray(grammarName)) {
    return (
      node.children.find((child) => grammarName.includes(child.type)) || null
    );
  }
  return node.children.find((child) => child.type === grammarName) || null;
}

/**
 * 주어진 노드의 자식 노드를 축소합니다.
 * @param node - 축소할 노드
 * @param code - 전체 코드 문자열
 * @param blockTypes - 블록 타입 배열
 * @param collapseTypes - 축소할 타입 배열
 * @param collapseBlockTypes - 축소할 블록 타입 배열
 * @param maxChunkSize - 최대 청크 크기
 * @returns 축소된 코드 문자열
 */
async function collapseChildren(
  node: SyntaxNode,
  code: string,
  blockTypes: string[],
  collapseTypes: string[],
  collapseBlockTypes: string[],
  maxChunkSize: number,
): Promise<string> {
  code = code.slice(0, node.endIndex);
  const block = firstChild(node, blockTypes);
  const collapsedChildren = [];

  if (block) {
    const childrenToCollapse = block.children.filter((child) =>
      collapseTypes.includes(child.type),
    );
    for (const child of childrenToCollapse.reverse()) {
      const grandChild = firstChild(child, collapseBlockTypes);
      if (grandChild) {
        const start = grandChild.startIndex;
        const end = grandChild.endIndex;
        const collapsedChild =
          code.slice(child.startIndex, start) +
          collapsedReplacement(grandChild);
        code =
          code.slice(0, start) +
          collapsedReplacement(grandChild) +
          code.slice(end);

        collapsedChildren.unshift(collapsedChild);
      }
    }
  }
  code = code.slice(node.startIndex);
  let removedChild = false;
  while (
    (await countTokensAsync(code.trim())) > maxChunkSize &&
    collapsedChildren.length > 0
  ) {
    removedChild = true;
    // Remove children starting at the end - TODO: Add multiple chunks so no children are missing
    const childCode = collapsedChildren.pop()!;
    const index = code.lastIndexOf(childCode);
    if (index > 0) {
      code = code.slice(0, index) + code.slice(index + childCode.length);
    }
  }

  if (removedChild) {
    // Remove the extra blank lines
    let lines = code.split("\n");
    let firstWhiteSpaceInGroup = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === "") {
        if (firstWhiteSpaceInGroup < 0) {
          firstWhiteSpaceInGroup = i;
        }
      } else {
        if (firstWhiteSpaceInGroup - i > 1) {
          // Remove the lines
          lines = [
            ...lines.slice(0, i + 1),
            ...lines.slice(firstWhiteSpaceInGroup + 1),
          ];
        }
        firstWhiteSpaceInGroup = -1;
      }
    }

    code = lines.join("\n");
  }

  return code;
}

export const FUNCTION_BLOCK_NODE_TYPES = ["block", "statement_block"];
export const FUNCTION_DECLARATION_NODE_TYPEs = [
  /// 함수 정의, 메서드 정의 등에서 사용되는 노드 타입
  "method_definition",
  "function_definition",
  "function_item",
  "function_declaration",
  "method_declaration",
];

/**
 * 클래스 정의 청크를 생성합니다.
 * @param node - 클래스 정의 노드
 * @param code - 전체 코드 문자열
 * @param maxChunkSize - 최대 청크 크기
 * @returns 축소된 클래스 정의 문자열
 */
async function constructClassDefinitionChunk(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
): Promise<string> {
  return collapseChildren(
    node,
    code,
    ["block", "class_body", "declaration_list"],
    FUNCTION_DECLARATION_NODE_TYPEs,
    FUNCTION_BLOCK_NODE_TYPES,
    maxChunkSize,
  );
}

/**
 * 함수 정의 청크를 생성합니다.
 * @param node - 함수 정의 노드
 * @param code - 전체 코드 문자열
 * @param maxChunkSize - 최대 청크 크기
 * @returns 축소된 함수 정의 문자열
 */
async function constructFunctionDefinitionChunk(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
): Promise<string> {
  const bodyNode = node.children[node.children.length - 1];
  const funcText =
    code.slice(node.startIndex, bodyNode.startIndex) +
    collapsedReplacement(bodyNode);

  if (
    node.parent &&
    ["block", "declaration_list"].includes(node.parent.type) &&
    node.parent.parent &&
    ["class_definition", "impl_item"].includes(node.parent.parent.type)
  ) {
    // If inside a class, include the class header
    const classNode = node.parent.parent;
    const classBlock = node.parent;
    return `${code.slice(
      classNode.startIndex,
      classBlock.startIndex,
    )}...\n\n${" ".repeat(node.startPosition.column)}${funcText}`;
  }
  return funcText;
}

/**
 * 축소된 노드 생성자 맵입니다.
 */
const collapsedNodeConstructors: {
  [key: string]: (
    node: SyntaxNode,
    code: string,
    maxChunkSize: number,
  ) => Promise<string>;
} = {
  // Classes, structs, etc
  class_definition: constructClassDefinitionChunk,
  class_declaration: constructClassDefinitionChunk,
  impl_item: constructClassDefinitionChunk,
  // Functions
  function_definition: constructFunctionDefinitionChunk,
  function_declaration: constructFunctionDefinitionChunk,
  function_item: constructFunctionDefinitionChunk,
  // Methods
  method_declaration: constructFunctionDefinitionChunk,
  // Properties
};

/**
 * 주어진 노드에 대한 청크를 생성합니다.
 * @param node - 청크를 생성할 노드
 * @param code - 전체 코드 문자열
 * @param maxChunkSize - 최대 청크 크기
 * @param root - 루트 노드 여부
 * @returns 생성된 청크 또는 undefined
 */
async function maybeYieldChunk(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
  root = true,
): Promise<ChunkWithoutID | undefined> {
  // Keep entire text if not over size
  if (root || node.type in collapsedNodeConstructors) {
    const tokenCount = await countTokensAsync(node.text);
    if (tokenCount < maxChunkSize) {
      return {
        content: node.text,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
      };
    }
  }
  return undefined;
}

/**
 * 스마트 축소된 청크를 생성하는 제너레이터입니다.
 * @param node - 청크를 생성할 노드
 * @param code - 전체 코드 문자열
 * @param maxChunkSize - 최대 청크 크기
 * @param root - 루트 노드 여부
 * @returns 생성된 청크 제너레이터
 */
async function* getSmartCollapsedChunks(
  node: SyntaxNode,
  code: string,
  maxChunkSize: number,
  root = true,
): AsyncGenerator<ChunkWithoutID> {
  const chunk = await maybeYieldChunk(node, code, maxChunkSize, root);
  if (chunk) {
    yield chunk;
    return;
  }
  // If a collapsed form is defined, use that
  if (node.type in collapsedNodeConstructors) {
    yield {
      content: await collapsedNodeConstructors[node.type](
        node,
        code,
        maxChunkSize,
      ),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
    };
  }

  // Recurse (because even if collapsed version was shown, want to show the children in full somewhere)
  const generators = node.children.map((child) =>
    getSmartCollapsedChunks(child, code, maxChunkSize, false),
  );
  for (const generator of generators) {
    yield* generator;
  }
}

/**
 * 코드 청크를 생성하는 제너레이터입니다.
 * @param filepath - 파일 경로
 * @param contents - 파일 내용
 * @param maxChunkSize - 최대 청크 크기
 * @returns 청크 제너레이터
 */
export async function* codeChunker(
  filepath: string,
  contents: string,
  maxChunkSize: number,
): AsyncGenerator<ChunkWithoutID> {
  if (contents.trim().length === 0) {
    return;
  }

  const parser = await getParserForFile(filepath);
  if (parser === undefined) {
    throw new Error(`Failed to load parser for file ${filepath}: `);
  }

  const tree = parser.parse(contents);

  yield* getSmartCollapsedChunks(tree.rootNode, contents, maxChunkSize);
}
