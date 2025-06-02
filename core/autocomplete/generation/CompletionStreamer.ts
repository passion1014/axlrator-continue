import { CompletionOptions, ILLM } from "../..";
import { StreamTransformPipeline } from "../filtering/streamTransforms/StreamTransformPipeline";
import { HelperVars } from "../util/HelperVars";

import { GeneratorReuseManager } from "./GeneratorReuseManager";
import { stopAfterMaxProcessingTime } from "./utils";

/**
 * CompletionStreamer는 LLM의 스트리밍 완성을 관리하는 클래스입니다.
 */
export class CompletionStreamer {
  private streamTransformPipeline = new StreamTransformPipeline();
  private generatorReuseManager: GeneratorReuseManager;

  constructor(onError: (err: any) => void) {
    this.generatorReuseManager = new GeneratorReuseManager(onError);
  }

  /**
   * 스트리밍 완성을 시작합니다.
   * @param token - AbortSignal로 요청을 중단할 수 있습니다.
   * @param llm - LLM 인스턴스
   * @param prefix - 현재 입력된 접두사
   * @param suffix - 현재 입력된 접미사
   * @param prompt - LLM에 전달할 프롬프트
   * @param multiline - 멀티라인 모드 여부
   * @param completionOptions - 완성 옵션
   * @param helper - 헬퍼 변수들
   */
  async *streamCompletionWithFilters(
    token: AbortSignal,
    llm: ILLM,
    prefix: string,
    suffix: string,
    prompt: string,
    multiline: boolean,
    completionOptions: Partial<CompletionOptions> | undefined,
    helper: HelperVars,
  ) {
    // Full stop은 LLM의 생성을 중단하는 것을 의미하며, 단순히 표시된 완성을 잘라내는 것이 아닙니다.
    const fullStop = () =>
      this.generatorReuseManager.currentGenerator?.cancel();

    // 사용자가 입력한 내용이 완성의 시작과 일치하면, 대기 중인 요청을 재사용하려고 시도합니다.
    const generator = this.generatorReuseManager.getGenerator(
      prefix,
      (abortSignal: AbortSignal) => {
        const generator = llm.supportsFim()
          ? llm.streamFim(prefix, suffix, abortSignal, completionOptions)
          : llm.streamComplete(prompt, abortSignal, {
              ...completionOptions,
              raw: true,
            });

        /**
         * 이 변환기는 재사용된 generator에도 적용됩니다. generator가 재사용되는 경우에도
         * 요청을 포착하고 중단하기 위해 streamTransformPipeline을 사용하지 않습니다.
         */
        return helper.options.transform
          ? stopAfterMaxProcessingTime(
              generator,
              helper.options.modelTimeout * 2.5,
              fullStop,
            )
          : generator;
      },
      multiline,
    );

    // LLM
    const generatorWithCancellation = async function* () {
      for await (const update of generator) {
        if (token.aborted) {
          return;
        }
        yield update;
      }
    };

    const initialGenerator = generatorWithCancellation();
    const transformedGenerator = helper.options.transform
      ? this.streamTransformPipeline.transform(
          initialGenerator,
          prefix,
          suffix,
          multiline,
          completionOptions?.stop || [],
          fullStop,
          helper,
        )
      : initialGenerator;

    for await (const update of transformedGenerator) {
      yield update;
    }
  }
}
