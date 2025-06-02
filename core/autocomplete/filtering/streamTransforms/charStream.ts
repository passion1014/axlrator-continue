/**
 * 입력 스트림에서 문자를 비동기적으로 생성하며,
 * 줄 끝 문자 다음에 공백이 아닌 문자가 나타날 때까지 문자를 생성합니다.
 *
 * @param {AsyncGenerator<string>} stream - 입력 문자 스트림.
 * @param {string[]} endOfLine - 줄 끝으로 간주되는 문자 배열.
 * @param {() => void} fullStop - 생성기가 중지될 때 호출되는 함수.
 * @yields {string} 입력 스트림에서 가져온 문자.
 * @returns {AsyncGenerator<string>} 문자를 생성하는 비동기 제너레이터.
 */
export async function* onlyWhitespaceAfterEndOfLine(
  stream: AsyncGenerator<string>,
  endOfLine: string[],
  fullStop: () => void,
): AsyncGenerator<string> {
  let pending = "";

  for await (let chunk of stream) {
    chunk = pending + chunk;
    pending = "";

    for (let i = 0; i < chunk.length - 1; i++) {
      if (
        endOfLine.includes(chunk[i]) &&
        chunk[i + 1].trim() === chunk[i + 1]
      ) {
        yield chunk.slice(0, i + 1);
        fullStop();
        return;
      }
    }

    if (endOfLine.includes(chunk[chunk.length - 1])) {
      pending = chunk[chunk.length - 1];
      yield chunk.slice(0, chunk.length - 1);
    } else {
      yield chunk;
    }
  }
  yield pending;
}

/**
 * 스트림에서 문자를 생성하며, 첫 번째 문자가 개행 문자일 경우 중지합니다.
 * @param {AsyncGenerator<string>} stream - 입력 문자 스트림.
 * @yields {string} 스트림에서 가져온 문자.
 */
export async function* noFirstCharNewline(stream: AsyncGenerator<string>) {
  let first = true;
  for await (const char of stream) {
    if (first) {
      first = false;
      if (char.startsWith("\n") || char.startsWith("\r")) {
        return;
      }
    }
    yield char;
  }
}

/**
 * 입력 스트림에서 문자를 비동기적으로 생성합니다.
 * 중지 토큰이 발견되면 생성을 중단합니다.
 *
 * @param {AsyncGenerator<string>} stream - 입력 문자 스트림.
 * @param {string[]} stopTokens - 중지 신호로 사용하는 토큰 배열.
 * @yields {string} 입력 스트림에서 가져온 문자.
 * @returns {AsyncGenerator<string>} 중지 조건이 충족될 때까지 문자를 생성하는 비동기 제너레이터.
 * @description
 * 1. 중지 토큰이 없으면 모든 문자를 생성합니다.
 * 2. 그렇지 않으면, 버퍼에 청크를 저장하고 중지 토큰을 확인합니다.
 * 3. 버퍼의 시작 부분에 중지 토큰이 없으면 한 글자씩 생성합니다.
 * 4. 중지 토큰이 발견되면 생성을 중단합니다.
 * 5. 스트림이 끝나면 남은 버퍼에서 중지 토큰을 제거합니다.
 * 6. 남은 버퍼의 문자를 모두 생성합니다.
 */
export async function* stopAtStopTokens(
  stream: AsyncGenerator<string>,
  stopTokens: string[],
): AsyncGenerator<string> {
  if (stopTokens.length === 0) {
    for await (const char of stream) {
      yield char;
    }
    return;
  }

  const maxStopTokenLength = Math.max(
    ...stopTokens.map((token) => token.length),
  );
  let buffer = "";

  for await (const chunk of stream) {
    buffer += chunk;

    while (buffer.length >= maxStopTokenLength) {
      let found = false;
      for (const stopToken of stopTokens) {
        if (buffer.startsWith(stopToken)) {
          found = true;
          return;
        }
      }

      if (!found) {
        yield buffer[0];
        buffer = buffer.slice(1);
      }
    }
  }
  // 남은 버퍼에서 중지 토큰을 제거
  stopTokens.forEach((token) => {
    buffer = buffer.replace(token, "");
  });

  // 남은 버퍼의 문자들을 모두 생성
  for (const char of buffer) {
    yield char;
  }
}

/**
 * 입력 스트림에서 문자를 비동기적으로 생성합니다.
 * 스트림에서 접미사의 시작이 감지되면 중지합니다.
 */
export async function* stopAtStartOf(
  stream: AsyncGenerator<string>,
  suffix: string,
  sequenceLength: number = 20,
): AsyncGenerator<string> {
  if (suffix.length < sequenceLength) {
    for await (const chunk of stream) {
      yield chunk;
    }
    return;
  }
  // 스트림이 접미사와 완벽히 정렬되지 않은 경우(공백 등) 시퀀스를 놓치지 않기 위해 sequenceLength * 1.5를 사용합니다.
  const targetPart = suffix
    .trimStart()
    .slice(0, Math.floor(sequenceLength * 1.5));

  let buffer = "";

  for await (const chunk of stream) {
    buffer += chunk;

    // targetPart에 버퍼가 포함되어 있으면 중지
    if (buffer.length >= sequenceLength && targetPart.includes(buffer)) {
      return;
    }

    // 버퍼가 sequenceLength를 초과하지 않도록 한 글자씩 생성
    while (buffer.length > sequenceLength) {
      yield buffer[0];
      buffer = buffer.slice(1);
    }
  }

  // 남은 버퍼가 targetPart에 포함되지 않으면 모두 생성
  if (buffer.length > 0) {
    yield buffer;
  }
}
