import { ListenableGenerator } from "./ListenableGenerator";

/**
 * GeneratorReuseManager는 자동완성 생성(context)에서 generator의 재사용을 관리합니다.
 * 가능한 경우 기존 generator를 재사용하고, 필요할 때 새 generator를 생성합니다.
 */
export class GeneratorReuseManager {
  currentGenerator: ListenableGenerator<string> | undefined;
  pendingGeneratorPrefix: string | undefined;
  pendingCompletion = "";

  constructor(private readonly onError: (err: any) => void) {}

  /**
   * 현재 generator를 취소하고 새 listenable generator를 생성합니다.
   * @param abortController - AbortController 인스턴스
   * @param gen - AsyncGenerator<string> 인스턴스
   * @param prefix - 현재 입력된 접두사
   */
  private _createListenableGenerator(
    abortController: AbortController,
    gen: AsyncGenerator<string>,
    prefix: string,
  ) {
    this.currentGenerator?.cancel();

    const listenableGen = new ListenableGenerator(
      gen,
      this.onError,
      abortController,
    );
    listenableGen.listen((chunk) => (this.pendingCompletion += chunk ?? ""));

    this.pendingGeneratorPrefix = prefix;
    this.pendingCompletion = "";
    this.currentGenerator = listenableGen;
  }

  /**
   * 현재 generator가 재사용 가능한지 확인합니다.
   * @param prefix - 현재 입력된 접두사
   * @returns true if the existing generator can be reused, false otherwise
   */
  private shouldReuseExistingGenerator(prefix: string): boolean {
    return (
      !!this.currentGenerator &&
      !!this.pendingGeneratorPrefix &&
      (this.pendingGeneratorPrefix + this.pendingCompletion).startsWith(
        prefix,
      ) &&
      // for e.g. backspace
      this.pendingGeneratorPrefix?.length <= prefix?.length
    );
  }

  /**
   * 현재 입력된 접두사에 따라 generator를 가져옵니다.
   * @param prefix - 현재 입력된 접두사
   * @param newGenerator - 새 generator를 생성하는 함수
   * @param multiline - 멀티라인 모드 여부
   * @returns AsyncGenerator<string> - 생성된 generator
   */
  async *getGenerator(
    prefix: string,
    newGenerator: (abortSignal: AbortSignal) => AsyncGenerator<string>,
    multiline: boolean,
  ): AsyncGenerator<string> {
    // If we can't reuse, then create a new generator
    if (!this.shouldReuseExistingGenerator(prefix)) {
      // Create a wrapper over the current generator to fix the prompt
      const abortController = new AbortController();
      this._createListenableGenerator(
        abortController,
        newGenerator(abortController.signal),
        prefix,
      );
    }

    // Already typed characters are those that are new in the prefix from the old generator
    let typedSinceLastGenerator =
      prefix.slice(this.pendingGeneratorPrefix?.length) || "";
    for await (let chunk of this.currentGenerator?.tee() ?? []) {
      if (!chunk) {
        continue;
      }

      // Ignore already typed characters in the completion
      while (chunk.length && typedSinceLastGenerator.length) {
        if (chunk[0] === typedSinceLastGenerator[0]) {
          typedSinceLastGenerator = typedSinceLastGenerator.slice(1);
          chunk = chunk.slice(1);
        } else {
          break;
        }
      }

      // Break at newline unless we are in multiline mode
      const newLineIndex = chunk.indexOf("\n");
      if (newLineIndex >= 0 && !multiline) {
        yield chunk.slice(0, newLineIndex);
        break;
      } else if (chunk !== "") {
        yield chunk;
      }
    }
  }
}
