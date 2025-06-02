export const BRACKETS: { [key: string]: string } = {
  "(": ")",
  "{": "}",
  "[": "]",
};
export const BRACKETS_REVERSE: { [key: string]: string } = {
  ")": "(",
  "}": "{",
  "]": "[",
};
/**
 * We follow the policy of only completing bracket pairs that we started
 * But sometimes we started the pair in a previous autocomplete suggestion
 */
/**
 * BracketMatchingService는 자동완성에서 괄호 매칭을 처리하는 서비스입니다.
 */
export class BracketMatchingService {
  private openingBracketsFromLastCompletion: string[] = [];
  private lastCompletionFile: string | undefined = undefined;

  /**
   * handleAcceptedCompletion은 사용자가 자동완성 결과를 수락했을 때 호출됩니다.
   * 이 메서드는 자동완성 결과에서 괄호 매칭을 처리합니다.
   * @param completion - 사용자가 수락한 자동완성 결과 문자열입니다.
   * @param filepath - 자동완성 결과가 발생한 파일의 경로입니다.
   */
  handleAcceptedCompletion(completion: string, filepath: string) {
    this.openingBracketsFromLastCompletion = [];
    const stack: string[] = [];

    for (let i = 0; i < completion.length; i++) {
      const char = completion[i];
      if (Object.keys(BRACKETS).includes(char)) {
        // It's an opening bracket
        stack.push(char);
      } else if (Object.values(BRACKETS).includes(char)) {
        // It's a closing bracket
        if (stack.length === 0 || BRACKETS[stack.pop()!] !== char) {
          break;
        }
      }
    }

    // Any remaining opening brackets in the stack are uncompleted
    this.openingBracketsFromLastCompletion = stack;
    this.lastCompletionFile = filepath;
  }

  /**
   * stopOnUnmatchedClosingBracket는 자동완성 스트림에서 닫는 괄호가 일치하지 않는 경우
   * 스트림을 중지하고 현재까지의 결과를 반환합니다.
   * @param stream - 자동완성 스트림입니다.
   * @param prefix - 현재 입력된 접두사입니다.
   * @param suffix - 현재 입력된 접미사입니다.
   * @param filepath - 자동완성 결과가 발생한 파일의 경로입니다.
   * @param multiline - 멀티라인 자동완성 여부입니다.
   */
  async *stopOnUnmatchedClosingBracket(
    stream: AsyncGenerator<string>,
    prefix: string,
    suffix: string,
    filepath: string,
    multiline: boolean, // Whether this is a multiline completion or not
  ): AsyncGenerator<string> {
    let stack: string[] = [];
    if (multiline) {
      // Add opening brackets from the previous response
      if (this.lastCompletionFile === filepath) {
        stack = [...this.openingBracketsFromLastCompletion];
      } else {
        this.lastCompletionFile = undefined;
      }
    } else {
      // If single line completion, then allow completing bracket pairs that are
      // started on the current line but not finished on the current line
      if (!multiline) {
        const currentLine =
          (prefix.split("\n").pop() ?? "") + (suffix.split("\n")[0] ?? "");
        for (let i = 0; i < currentLine.length; i++) {
          const char = currentLine[i];
          if (Object.keys(BRACKETS).includes(char)) {
            // It's an opening bracket
            stack.push(char);
          } else if (Object.values(BRACKETS).includes(char)) {
            // It's a closing bracket
            if (stack.length === 0 || BRACKETS[stack.pop()!] !== char) {
              break;
            }
          }
        }
      }
    }

    // Add corresponding open brackets from suffix to stack
    // because we overwrite them and the diff is displayed, and this allows something to be edited after that
    for (let i = 0; i < suffix.length; i++) {
      if (suffix[i] === " ") {
        continue;
      }
      const openBracket = BRACKETS_REVERSE[suffix[i]];
      if (!openBracket) {
        break;
      }
      stack.unshift(openBracket);
    }

    let all = "";
    let seenNonWhitespaceOrClosingBracket = false;
    for await (let chunk of stream) {
      // Allow closing brackets before any non-whitespace characters
      if (!seenNonWhitespaceOrClosingBracket) {
        const firstNonWhitespaceOrClosingBracketIndex =
          chunk.search(/[^\s\)\}\]]/);
        if (firstNonWhitespaceOrClosingBracketIndex !== -1) {
          yield chunk.slice(0, firstNonWhitespaceOrClosingBracketIndex);
          chunk = chunk.slice(firstNonWhitespaceOrClosingBracketIndex);
          seenNonWhitespaceOrClosingBracket = true;
        } else {
          yield chunk;
          continue;
        }
      }

      all += chunk;
      const allLines = all.split("\n");
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];
        if (Object.values(BRACKETS).includes(char)) {
          // It's a closing bracket
          if (stack.length === 0 || BRACKETS[stack.pop()!] !== char) {
            // If the stack is empty or the top of the stack doesn't match the current closing bracket
            yield chunk.slice(0, i);
            return; // Stop the generator if the closing bracket doesn't have a matching opening bracket in the stream
          }
        } else if (Object.keys(BRACKETS).includes(char)) {
          // It's an opening bracket
          stack.push(char);
        }
      }
      yield chunk;
    }
  }
}
