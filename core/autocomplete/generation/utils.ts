/**
 * 주어진 스트림에서 최대 처리 시간 이후에 중단합니다.
 * @param stream - 처리할 스트림
 * @param maxTimeMs - 최대 처리 시간(밀리초)
 * @param fullStop - 중단 시 호출할 함수
 * @returns 중단된 스트림
 */
export async function* stopAfterMaxProcessingTime(
  stream: AsyncGenerator<string>,
  maxTimeMs: number,
  fullStop: () => void,
): AsyncGenerator<string> {
  const startTime = Date.now();
  /**
   * Check every 10 chunks to avoid performance overhead.
   */
  const checkInterval = 10;
  let chunkCount = 0;
  let totalCharCount = 0;

  for await (const chunk of stream) {
    yield chunk;

    chunkCount++;
    totalCharCount += chunk.length;

    if (chunkCount % checkInterval === 0) {
      if (Date.now() - startTime > maxTimeMs) {
        fullStop();
        return;
      }
    }
  }
}
