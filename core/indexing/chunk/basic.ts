import { ChunkWithoutID } from "../../index.js";
import { countTokensAsync } from "../../llm/countTokens.js";

/**
 * 기본 청크 생성기
 * 주어진 문자열을 최대 청크 크기에 맞게 분할합니다.
 * @param contents - 분할할 문자열
 * @param maxChunkSize - 최대 청크 크기
 * @returns 청크 제너레이터
 */
export async function* basicChunker(
  contents: string,
  maxChunkSize: number,
): AsyncGenerator<ChunkWithoutID> {
  if (contents.trim().length === 0) {
    return;
  }

  let chunkContent = "";
  let chunkTokens = 0;
  let startLine = 0;
  let currLine = 0;

  const lineTokens = await Promise.all(
    contents.split("\n").map(async (l) => {
      return {
        line: l,
        tokenCount: await countTokensAsync(l),
      };
    }),
  );

  for (const lt of lineTokens) {
    if (chunkTokens + lt.tokenCount > maxChunkSize - 5) {
      yield { content: chunkContent, startLine, endLine: currLine - 1 };
      chunkContent = "";
      chunkTokens = 0;
      startLine = currLine;
    }

    if (lt.tokenCount < maxChunkSize) {
      chunkContent += `${lt.line}\n`;
      chunkTokens += lt.tokenCount + 1;
    }

    currLine++;
  }

  yield {
    content: chunkContent,
    startLine,
    endLine: currLine - 1,
  };
}
