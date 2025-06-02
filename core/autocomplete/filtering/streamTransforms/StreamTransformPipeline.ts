import { streamLines } from "../../../diff/util";
import { HelperVars } from "../../util/HelperVars";

import { stopAtStartOf, stopAtStopTokens } from "./charStream";
import {
  avoidEmptyComments,
  avoidPathLine,
  noDoubleNewLine,
  showWhateverWeHaveAtXMs,
  skipPrefixes,
  stopAtLines,
  stopAtLinesExact,
  stopAtRepeatingLines,
  stopAtSimilarLine,
  streamWithNewLines,
} from "./lineStream";

const STOP_AT_PATTERNS = ["diff --git"];

/**
 * StreamTransformPipeline 클래스는 스트림 변환 파이프라인을 구현합니다.
 */
export class StreamTransformPipeline {
  async *transform(
    generator: AsyncGenerator<string>,
    prefix: string,
    suffix: string,
    multiline: boolean,
    stopTokens: string[],
    fullStop: () => void,
    helper: HelperVars,
  ): AsyncGenerator<string> {
    let charGenerator = generator;

    charGenerator = stopAtStopTokens(generator, [
      ...stopTokens,
      ...STOP_AT_PATTERNS,
    ]);
    charGenerator = stopAtStartOf(charGenerator, suffix);
    for (const charFilter of helper.lang.charFilters ?? []) {
      charGenerator = charFilter({
        chars: charGenerator,
        prefix,
        suffix,
        filepath: helper.filepath,
        multiline,
      });
    }

    let lineGenerator = streamLines(charGenerator);

    lineGenerator = stopAtLines(lineGenerator, fullStop);
    const lineBelowCursor = this.getLineBelowCursor(helper);
    if (lineBelowCursor.trim() !== "") {
      lineGenerator = stopAtLinesExact(lineGenerator, fullStop, [
        lineBelowCursor,
      ]);
    }
    lineGenerator = stopAtRepeatingLines(lineGenerator, fullStop);
    lineGenerator = avoidEmptyComments(
      lineGenerator,
      helper.lang.singleLineComment,
    );
    lineGenerator = avoidPathLine(lineGenerator, helper.lang.singleLineComment);
    lineGenerator = skipPrefixes(lineGenerator);
    lineGenerator = noDoubleNewLine(lineGenerator);

    for (const lineFilter of helper.lang.lineFilters ?? []) {
      lineGenerator = lineFilter({ lines: lineGenerator, fullStop });
    }

    lineGenerator = stopAtSimilarLine(
      lineGenerator,
      this.getLineBelowCursor(helper),
      fullStop,
    );

    const timeoutValue = helper.options.modelTimeout;

    lineGenerator = showWhateverWeHaveAtXMs(lineGenerator, timeoutValue!);

    const finalGenerator = streamWithNewLines(lineGenerator);
    for await (const update of finalGenerator) {
      yield update;
    }
  }

  /**
   * 커서 아래의 줄을 가져옵니다.
   * @param helper - 헬퍼 변수들
   * @returns 커서 아래의 줄 문자열
   */
  private getLineBelowCursor(helper: HelperVars): string {
    let lineBelowCursor = "";
    let i = 1;
    while (
      lineBelowCursor.trim() === "" &&
      helper.pos.line + i <= helper.fileLines.length - 1
    ) {
      lineBelowCursor =
        helper.fileLines[
          Math.min(helper.pos.line + i, helper.fileLines.length - 1)
        ];
      i++;
    }
    return lineBelowCursor;
  }
}
