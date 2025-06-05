import { Chunk, ChunkWithoutID } from "../../index.js";
import { countTokensAsync } from "../../llm/countTokens.js";
import { supportedLanguages } from "../../util/treeSitter.js";
import { getUriFileExtension, getUriPathBasename } from "../../util/uri.js";

import { basicChunker } from "./basic.js";
import { codeChunker } from "./code.js";

export type ChunkDocumentParam = {
  filepath: string;
  contents: string;
  maxChunkSize: number;
  digest: string;
};

/**
 * 주어진 파일 URI와 내용에서 청크를 생성합니다.
 * @param fileUri - 파일 URI
 * @param contents - 파일 내용
 * @param maxChunkSize - 최대 청크 크기
 * @returns 청크 제너레이터
 */
async function* chunkDocumentWithoutId(
  fileUri: string,
  contents: string,
  maxChunkSize: number,
): AsyncGenerator<ChunkWithoutID> {
  if (contents.trim() === "") {
    return;
  }
  const extension = getUriFileExtension(fileUri);
  if (extension in supportedLanguages) {
    try {
      for await (const chunk of codeChunker(fileUri, contents, maxChunkSize)) {
        yield chunk;
      }
      return;
    } catch (e: any) {
      // falls back to basicChunker
    }
  }

  yield* basicChunker(contents, maxChunkSize);
}

/**
 * 주어진 파일 경로와 내용에서 청크를 생성합니다.
 * @param param0 - 청크 생성에 필요한 매개변수
 */
export async function* chunkDocument({
  filepath,
  contents,
  maxChunkSize,
  digest,
}: ChunkDocumentParam): AsyncGenerator<Chunk> {
  let index = 0;
  const chunkPromises: Promise<Chunk | undefined>[] = [];
  for await (const chunkWithoutId of chunkDocumentWithoutId(
    filepath,
    contents,
    maxChunkSize,
  )) {
    chunkPromises.push(
      new Promise(async (resolve) => {
        if ((await countTokensAsync(chunkWithoutId.content)) > maxChunkSize) {
          // console.debug(
          //   `Chunk with more than ${maxChunkSize} tokens constructed: `,
          //   filepath,
          //   countTokens(chunkWithoutId.content),
          // );
          return resolve(undefined);
        }
        resolve({
          ...chunkWithoutId,
          digest,
          index,
          filepath,
        });
      }),
    );
    index++;
  }
  for await (const chunk of chunkPromises) {
    if (!chunk) {
      continue;
    }
    yield chunk;
  }
}

/**
 * 파일이 청크화되어야 하는지 여부를 결정합니다.
 * @param fileUri - 파일 URI
 * @param contents - 파일 내용
 * @returns 청크화 여부
 */
export function shouldChunk(fileUri: string, contents: string): boolean {
  if (contents.length > 1000000) {
    // if a file has more than 1m characters then skip it
    return false;
  }
  if (contents.length === 0) {
    return false;
  }
  const baseName = getUriPathBasename(fileUri);
  return baseName.includes(".");
}
