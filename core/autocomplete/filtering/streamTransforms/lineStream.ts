import { distance } from "fastest-levenshtein";

import { DiffLine } from "../../..";
import { LineStream } from "../../../diff/util";

export type LineFilter = (args: {
  lines: LineStream;
  fullStop: () => void;
}) => LineStream;

export type CharacterFilter = (args: {
  chars: AsyncGenerator<string>;
  prefix: string;
  suffix: string;
  filepath: string;
  multiline: boolean;
}) => AsyncGenerator<string>;

/**
 * 라인이 괄호로 끝나는지 판단합니다.
 * @param {string} line - 검사할 라인
 * @returns {boolean} - 라인이 괄호로 끝나면 true, 아니면 false
 *
 * @description
 * 라인이 괄호로 끝나는지 확인합니다. 괄호는 ) , ] , } , ; 중 하나입니다.
 */
function isBracketEnding(line: string): boolean {
  return line
    .trim()
    .split("")
    .some((char) => BRACKET_ENDING_CHARS.includes(char));
}

/**
 * 라인이 영어로 작성된 코드 블록의 첫 번째 라인인지 판단합니다.
 * @param {string} line - 검사할 라인
 * @returns {boolean} - 영어로 작성된 코드 블록의 첫 번째 라인이면 true, 아니면 false
 *
 * @description
 * 라인이 영어로 시작하는 특정 구문으로 시작하는지 확인합니다.
 * 코드 키워드가 세미콜론으로 끝나는 경우를 제외합니다.
 */
function isEnglishFirstLine(line: string) {
  line = line.trim().toLowerCase();

  if (
    line.endsWith(":") &&
    !CODE_KEYWORDS_ENDING_IN_SEMICOLON.some((keyword) =>
      line.startsWith(keyword),
    )
  ) {
    return true;
  }

  return ENGLISH_START_PHRASES.some((phrase) => line.startsWith(phrase));
}

/**
 * 라인이 영어로 작성된 코드 블록의 설명인지 판단합니다.
 * @param {string} line - 검사할 라인
 * @returns {boolean} - 영어로 작성된 코드 블록의 설명이면 true, 아니면 false
 *
 * @description
 * 라인이 영어로 작성된 코드 블록의 설명인지 판단합니다.
 * 라인이 영어로 시작하는 특정 구문으로 시작하는지 확인합니다.
 */
function isEnglishPostExplanation(line: string): boolean {
  const lower = line.toLowerCase();
  return ENGLISH_POST_PHRASES.some((phrase) => lower.startsWith(phrase));
}

/**
 * 라인이 코드 블록 시작 전 제거해야 하는지 판단합니다.
 * @param {string} line - 검사할 라인
 * @returns {boolean} - 라인을 제거해야 하면 true, 아니면 false
 *
 * @description
 * 라인이 코드 블록의 시작( ``` )이거나, 특정 제거 대상 라인 목록에 포함된 경우 true를 반환합니다.
 */
function shouldRemoveLineBeforeStart(line: string): boolean {
  return (
    line.trimStart().startsWith("```") ||
    LINES_TO_REMOVE_BEFORE_START.some((l) => line.trim() === l)
  );
}

/**
 * 라인이 변경되어야 하는지 판단하고, 필요시 라인을 변경하고 스트림을 중단합니다.
 * @param {string} line - 검사할 라인
 * @returns {string | undefined} - 변경된 라인 또는 undefined
 *
 * @description
 * 라인이 코드 블록의 시작( ``` )이거나, 코드 블록 중단 문구( [/CODE] )를 포함하는 경우,
 * 해당 라인을 반환합니다. 그렇지 않으면 undefined를 반환합니다.
 */
function shouldChangeLineAndStop(line: string): string | undefined {
  if (line.trimStart() === "```") {
    return line;
  }

  if (line.includes(CODE_STOP_BLOCK)) {
    return line.split(CODE_STOP_BLOCK)[0].trimEnd();
  }

  return undefined;
}

/**
 * 라인이 불필요한지 판단합니다.
 * @param {string} line - 검사할 라인
 * @returns {boolean} - 라인이 불필요하면 true, 아니면 false
 *
 * @description
 * 라인이 비어 있거나 "// end"로 시작하는 경우 불필요한 라인으로 간주합니다.
 */
function isUselessLine(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  const hasUselessLine = USELESS_LINES.some(
    (uselessLine) => trimmed === uselessLine,
  );

  return hasUselessLine || trimmed.startsWith("// end");
}

export const USELESS_LINES = [""];
export const CODE_KEYWORDS_ENDING_IN_SEMICOLON = ["def"];
export const CODE_STOP_BLOCK = "[/CODE]";
export const BRACKET_ENDING_CHARS = [")", "]", "}", ";"];
export const PREFIXES_TO_SKIP = ["<COMPLETION>"];
export const LINES_TO_STOP_AT = ["# End of file.", "<STOP EDITING HERE"];
export const LINES_TO_SKIP = ["</START EDITING HERE>"];
export const LINES_TO_REMOVE_BEFORE_START = [
  "<COMPLETION>",
  "[CODE]",
  "<START EDITING HERE>",
  "{{FILL_HERE}}",
];

export const ENGLISH_START_PHRASES = [
  "here is",
  "here's",
  "sure, here",
  "sure thing",
  "sure!",
  "to fill",
  "certainly",
  "of course",
  "the code should",
];

export const ENGLISH_POST_PHRASES = [
  "explanation:",
  "here is",
  "here's how",
  "the above",
];

// 상위 레벨 키워드가 중간에 등장하는 라인을 필터링합니다.
export async function* noTopLevelKeywordsMidline(
  lines: LineStream,
  topLevelKeywords: string[],
  fullStop: () => void,
): LineStream {
  for await (const line of lines) {
    for (const keyword of topLevelKeywords) {
      const indexOf = line.indexOf(`${keyword} `);
      // TODO: 이 두 번째 조건절의 용도는 무엇인가요?
      if (indexOf >= 0 && line.slice(indexOf - 1, indexOf).trim() !== "") {
        yield line.slice(0, indexOf);
        fullStop();
        break;
      }
    }
    yield line;
  }
}

/**
 * LineStream에서 '// Path: <PATH>'로 시작하는 라인을 필터링합니다.
 *
 * @param {LineStream} stream - 필터링할 입력 라인 스트림
 * @param {string} comment - 필터링할 주석 구문 (예: JavaScript 스타일의 '//' 등)
 * @yields {string} 원하지 않는 경로 라인을 제외한 필터링된 라인
 */
export async function* avoidPathLine(
  stream: LineStream,
  comment?: string,
): LineStream {
  // 스니펫은 '// Path: <PATH>'로 시작하는 주석 라인으로 삽입됩니다.
  // 모델이 이 패턴을 복사하는 경우가 있는데, 이는 원하지 않는 동작입니다.
  for await (const line of stream) {
    if (line.startsWith(`${comment} Path: `)) {
      continue;
    }
    yield line;
  }
}

/**
 * LineStream에서 빈 주석 라인을 필터링합니다.
 *
 * @param {LineStream} stream - 필터링할 입력 라인 스트림
 * @param {string} comment - 필터링할 주석 구문 (예: JavaScript 스타일의 '//' 등)
 * @yields {string} 빈 주석을 제외한 필터링된 라인
 */
export async function* avoidEmptyComments(
  stream: LineStream,
  comment?: string,
): LineStream {
  // 빈 주석 라인을 필터링합니다.
  for await (const line of stream) {
    if (!comment || line.trim() !== comment) {
      yield line;
    }
  }
}

/**
 * LineStream을 변환하여 라인 사이에 개행 문자를 추가합니다.
 *
 * @param {LineStream} stream - 입력 라인 스트림
 * @yields {string} 라인 사이에 개행 문자가 추가된 라인
 */
export async function* streamWithNewLines(stream: LineStream): LineStream {
  let firstLine = true;
  for await (const nextLine of stream) {
    if (!firstLine) {
      yield "\n";
    }
    firstLine = false;
    yield nextLine;
  }
}

/**
 * 두 텍스트 라인이 반복되거나 매우 유사한지 판단합니다.
 *
 * @param {string} a - 비교할 첫 번째 라인
 * @param {string} b - 비교할 두 번째 라인
 * @returns {boolean} 라인이 반복된 것으로 간주되면 true, 아니면 false
 *
 * @description
 * 두 라인의 Levenshtein 거리가 두 번째 라인의 길이의 10% 미만이면 반복된 것으로 간주합니다.
 * 5자 미만의 라인은 반복된 것으로 간주하지 않습니다.
 */
export function lineIsRepeated(a: string, b: string): boolean {
  if (a.length <= 4 || b.length <= 4) {
    return false;
  }

  const aTrim = a.trim();
  const bTrim = b.trim();
  return distance(aTrim, bTrim) / bTrim.length < 0.1;
}

/**
 * LineStream을 필터링하여, 주어진 라인과 유사한 라인이 등장하면 중단합니다.
 *
 * @param {LineStream} stream - 필터링할 입력 라인 스트림
 * @param {string} line - 유사성을 비교할 라인
 * @param {() => void} fullStop - 스트림을 중단할 때 호출할 함수
 * @yields {string} 유사한 라인이 등장하기 전까지의 필터링된 라인
 *
 * @description
 * 다음 조건 중 하나라도 만족하면 fullStop을 호출하고 중단합니다:
 * 1. 주어진 라인과 정확히 일치하는 경우
 * 2. 반복되거나 매우 유사한 라인인 경우
 * 3. 괄호로 끝나는 라인의 경우, 트림된 내용이 정확히 일치하면 허용
 */
export async function* stopAtSimilarLine(
  stream: LineStream,
  line: string,
  fullStop: () => void,
): AsyncGenerator<string> {
  const trimmedLine = line.trim();
  const lineIsBracketEnding = isBracketEnding(trimmedLine);

  for await (const nextLine of stream) {
    if (trimmedLine === "") {
      yield nextLine;
      continue;
    }

    if (lineIsBracketEnding && trimmedLine.trim() === nextLine.trim()) {
      yield nextLine;
      continue;
    }

    if (nextLine === line) {
      fullStop();
      break;
    }

    if (lineIsRepeated(nextLine, trimmedLine)) {
      fullStop();
      break;
    }

    yield nextLine;
  }
}

/**
 * LineStream을 필터링하여, 지정된 중단 문구가 포함된 라인이 등장하면 중단합니다.
 * @param {LineStream} stream - 입력 라인 스트림
 * @param {() => void} fullStop - 중단 시 호출할 함수
 * @yields {string} 중단 문구가 등장하기 전까지의 필터링된 라인
 */
export async function* stopAtLines(
  stream: LineStream,
  fullStop: () => void,
  linesToStopAt: string[] = LINES_TO_STOP_AT,
): LineStream {
  for await (const line of stream) {
    if (linesToStopAt.some((stopAt) => line.trim().includes(stopAt))) {
      fullStop();
      break;
    }
    yield line;
  }
}

/**
 * LineStream을 필터링하여, 지정된 라인과 정확히 일치하는 라인이 등장하면 중단합니다.
 * @param {LineStream} stream - 입력 라인 스트림
 * @param {() => void} fullStop - 중단 시 호출할 함수
 * @param {string[]} linesToStopAt - 중단할 라인 목록
 * @yields {string} 중단 문구가 등장하기 전까지의 필터링된 라인
 */
export async function* stopAtLinesExact(
  stream: LineStream,
  fullStop: () => void,
  linesToStopAt: string[],
): LineStream {
  for await (const line of stream) {
    if (linesToStopAt.some((stopAt) => line === stopAt)) {
      fullStop();
      break;
    }
    yield line;
  }
}

/**
 * LineStream의 첫 번째 라인에서 지정된 접두사를 건너뜁니다.
 * @param {LineStream} lines - 입력 라인 스트림
 * @yields {string} 첫 번째 라인에서 접두사가 제거된 라인
 */
export async function* skipPrefixes(lines: LineStream): LineStream {
  let isFirstLine = true;
  for await (const line of lines) {
    if (isFirstLine) {
      const match = PREFIXES_TO_SKIP.find((prefix) => line.startsWith(prefix));
      if (match) {
        yield line.slice(match.length);
        continue;
      }
      isFirstLine = false;
    }
    yield line;
  }
}

/**
 * 지정된 접두사로 시작하는 라인을 LineStream에서 건너뜁니다.
 * @param {LineStream} stream - 입력 라인 스트림
 * @yields {string} LINES_TO_SKIP 접두사로 시작하지 않는 라인
 */
export async function* skipLines(stream: LineStream): LineStream {
  for await (const line of stream) {
    if (!LINES_TO_SKIP.some((skipAt) => line.startsWith(skipAt))) {
      yield line;
    }
  }
}

/**
 * 원본 라인에 후행 공백이 있지만 새 라인에는 없는 경우를 처리합니다.
 * @param {LineStream} stream - 입력 라인 스트림
 * @yields {string} 후행 공백이 제거된 라인
 */
export async function* removeTrailingWhitespace(
  stream: LineStream,
): LineStream {
  for await (const line of stream) {
    yield line.trimEnd();
  }
}

/**
 * 코드 블록에서 불필요한 마커를 제거하고, 특수 케이스를 처리하며 라인을 필터링합니다.
 *
 * @param {LineStream} rawLines - 필터링할 입력 라인 스트림
 * @yields {string} 코드 블록의 필터링 및 처리된 라인
 *
 * @description
 * 1. 실제 코드가 시작되기 전 제거해야 할 라인을 삭제합니다.
 * 2. 마지막 라인이 아닌 경우 코드 블록 마커( ```)를 필터링합니다.
 * 3. 라인을 변경하고 스트림을 중단해야 하는 특수 케이스를 처리합니다.
 * 4. 실제 코드 블록 내용의 라인을 반환합니다.
 */
export async function* filterCodeBlockLines(rawLines: LineStream): LineStream {
  let seenFirstFence = false;
  // nestCount는 전체 코드 블록이 ``` 또는 START 블록으로 감싸진 경우 1로 설정됩니다.
  // 내부 코드 블록이 발견되면 증가하며, 모든 블록이 매칭되면 조기 종료합니다.
  // 외부 펜스가 없으면 끝까지 계속됩니다.
  let nestCount = 0;

  for await (const line of rawLines) {
    if (!seenFirstFence) {
      if (shouldRemoveLineBeforeStart(line)) {
        // 시작 ``` 또는 START 블록을 필터링합니다.
        continue;
      }
      // 펜스 또는 START 블록 여부와 상관없이 중첩 레벨을 추적합니다.
      seenFirstFence = true;
      nestCount = 1;
    }

    if (nestCount > 0) {
      // 블록 내부(외부 블록 포함)
      const changedEndLine = shouldChangeLineAndStop(line);
      if (typeof changedEndLine === "string") {
        // ``` 또는 STOP으로 블록 종료
        nestCount--;
        if (nestCount === 0) {
          // 외부 블록을 닫는 경우 조기 종료
          // 외부 블록이 블록으로 시작한 경우에만 조기 종료
          // 텍스트로 시작한 경우에는 끝까지 계속
          return;
        } else {
          // 그렇지 않으면 라인을 반환
          yield line;
        }
      } else if (line.startsWith("```")) {
        // 중첩 코드 블록 진입
        nestCount++;
        yield line;
      } else {
        // 그 외에는 라인을 반환
        yield line;
      }
    }
  }
}

/**
 * 코드 블록 시작 부분의 영어 설명을 필터링합니다.
 *
 * @param {LineStream} lines - 입력 라인 스트림
 * @yields {string} 시작 부분의 영어 설명이 제거된 라인
 *
 * @description
 * 1. 처음의 빈 라인을 건너뜁니다.
 * 2. 첫 번째 라인이 영어 설명이면 제거합니다.
 * 3. 첫 번째 라인이 영어 설명이었고, 그 다음 라인이 빈 라인이면 제거합니다.
 * 4. 나머지 라인을 반환합니다.
 */
export async function* filterEnglishLinesAtStart(lines: LineStream) {
  let i = 0;
  let wasEnglishFirstLine = false;
  for await (const line of lines) {
    if (i === 0 && line.trim() === "") {
      continue;
    }

    if (i === 0) {
      if (isEnglishFirstLine(line)) {
        wasEnglishFirstLine = true;
        i++;
        continue;
      }
    } else if (i === 1 && wasEnglishFirstLine && line.trim() === "") {
      i++;
      continue;
    }
    i++;
    yield line;
  }
}

/**
 * 코드 블록 끝 부분의 영어 설명을 필터링합니다.
 * @param {LineStream} lines - 입력 라인 스트림
 * @yields {string} 코드 블록 끝 또는 영어 설명 시작 전까지의 라인
 */
export async function* filterEnglishLinesAtEnd(lines: LineStream) {
  let finishedCodeBlock = false;

  for await (const line of lines) {
    if (line.trim() === "```") {
      finishedCodeBlock = true;
    }
    if (finishedCodeBlock && isEnglishPostExplanation(line)) {
      break;
    }
    yield line;
  }
}

/**
 * LineStream에서 첫 번째 빈 줄을 건너뜁니다.
 * @param {LineStream} lines - 입력 라인 스트림
 * @yields {string} 첫 번째 빈 줄이 제거된 라인
 */
export async function* filterLeadingNewline(lines: LineStream): LineStream {
  let firstLine = true;
  for await (const line of lines) {
    if (firstLine && line.trim() === "") {
      firstLine = false;
      continue;
    }
    yield line;
  }
}

/**
 * CodeLlama 출력의 첫 번째 라인의 들여쓰기를 제거합니다.
 * @param {LineStream} lines - 입력 라인 스트림
 * @yields {string} 첫 번째 라인의 들여쓰기가 수정된 라인
 */
export async function* fixCodeLlamaFirstLineIndentation(lines: LineStream) {
  let isFirstLine = true;

  for await (const line of lines) {
    if (isFirstLine && line.startsWith("  ")) {
      yield line.slice(2);
      isFirstLine = false;
    } else {
      yield line;
    }
  }
}

/**
 * diff 라인 스트림에서 앞뒤의 빈 라인 삽입을 필터링합니다.
 *
 * @param {AsyncGenerator<DiffLine>} diffLines - DiffLine 객체를 반환하는 async generator
 * @yields {DiffLine} 앞뒤의 빈 라인 삽입이 제거된 DiffLine 객체
 *
 * @description
 * 1. 시작 부분의 빈 라인 삽입을 건너뜁니다.
 * 2. 이후 빈 라인 삽입은 버퍼링합니다.
 * 3. 빈 라인이 아닌 삽입이 등장하면 버퍼된 빈 라인을 반환합니다.
 * 4. 기존(old) 라인이 등장하면 버퍼를 비웁니다.
 * 5. 빈 라인이 아닌 삽입 및 기존 라인은 모두 반환합니다.
 */
export async function* filterLeadingAndTrailingNewLineInsertion(
  diffLines: AsyncGenerator<DiffLine>,
): AsyncGenerator<DiffLine> {
  let isFirst = true;
  let buffer: DiffLine[] = [];

  for await (const diffLine of diffLines) {
    const isBlankLineInsertion =
      diffLine.type === "new" && isUselessLine(diffLine.line);

    if (isFirst && isBlankLineInsertion) {
      isFirst = false;
      continue;
    }

    isFirst = false;

    if (isBlankLineInsertion) {
      buffer.push(diffLine);
    } else {
      if (diffLine.type === "old") {
        buffer = [];
      } else {
        while (buffer.length > 0) {
          yield buffer.shift()!;
        }
      }
      yield diffLine;
    }
  }
}

/**
 * 라인이 지정된 횟수 이상 반복되면 LineStream을 중단합니다.
 *
 * @param {LineStream} lines - 필터링할 입력 라인 스트림
 * @param {() => void} fullStop - 스트림을 중단할 때 호출할 함수
 * @yields {string} 과도한 반복이 감지되기 전까지의 라인
 *
 * @description
 * 동일한 라인이 최대 3회 연속 반복되면 fullStop을 호출하고 중단합니다.
 * 반복되는 라인 중 첫 번째 라인만 반환합니다.
 */
export async function* stopAtRepeatingLines(
  lines: LineStream,
  fullStop: () => void,
): LineStream {
  let previousLine: string | undefined;
  let repeatCount = 0;
  const MAX_REPEATS = 3;

  for await (const line of lines) {
    if (line === previousLine) {
      repeatCount++;
      if (repeatCount === MAX_REPEATS) {
        fullStop();
        return;
      }
    } else {
      yield line;
      repeatCount = 1;
    }
    previousLine = line;
  }
}

/**
 * 패스스루, 마지막에 전체 출력을 로그로 남깁니다.
 * @param lines `LineStream`
 */
export async function* logLines(
  lines: LineStream,
  prefix: string = "STREAMED LINES",
): LineStream {
  let linesToLog = [];
  for await (const line of lines) {
    yield line;
    linesToLog.push(line);
  }
  console.log(`${prefix}:\n${linesToLog.join("\n")}\n\n`);
}

/**
 * 지정된 시간(ms) 동안 LineStream에서 라인을 출력합니다.
 * 첫 번째 비어 있지 않은 라인이 출력되면 중단합니다.
 *
 * @param {LineStream} lines - 입력 라인 스트림
 * @param {number} ms - 대기 시간 (밀리초)
 * @yields {string} 지정된 시간 동안의 라인
 */
export async function* showWhateverWeHaveAtXMs(
  lines: LineStream,
  ms: number,
): LineStream {
  const startTime = Date.now();
  let firstNonWhitespaceLineYielded = false;

  for await (const line of lines) {
    yield line;

    if (!firstNonWhitespaceLineYielded && line.trim() !== "") {
      firstNonWhitespaceLineYielded = true;
    }

    const isTakingTooLong = Date.now() - startTime > ms;
    if (isTakingTooLong && firstNonWhitespaceLineYielded) {
      break;
    }
  }
}

/**
 * LineStream에서 연속된 빈 줄을 제거합니다.
 * 첫 번째 빈 줄은 허용되지만, 두 번째 빈 줄은 제거합니다.
 *
 * @param {LineStream} lines - 입력 라인 스트림
 * @yields {string} 연속된 빈 줄이 제거된 라인
 */
export async function* noDoubleNewLine(lines: LineStream): LineStream {
  let isFirstLine = true;

  for await (const line of lines) {
    if (line.trim() === "" && !isFirstLine) {
      return;
    }

    isFirstLine = false;

    yield line;
  }
}
