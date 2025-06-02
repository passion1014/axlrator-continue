import { DataLogger } from "../../data/log";
import { COUNT_COMPLETION_REJECTED_AFTER } from "../../util/parameters";
import { Telemetry } from "../../util/posthog";
import { getUriFileExtension } from "../../util/uri";

import { AutocompleteOutcome } from "./types";

/**
 * 자동완성 로깅 서비스를 제공하는 클래스입니다.
 *
 * 각 completionId에 대해 AbortController, 거절 타임아웃, 결과(AutocompleteOutcome)를 관리합니다.
 * 자동완성 결과가 표시, 수락, 거절되는 시점에 따라 로깅 및 타임아웃 처리를 담당합니다.
 *
 * @remarks
 * - 자동완성 결과가 표시되면 일정 시간(기본 10초) 내에 수락되지 않으면 거절로 간주하여 로깅합니다.
 * - 이전에 표시된 자동완성 결과와 현재 결과가 연속된 경우, 이전 결과의 거절 타임아웃을 취소합니다.
 * - 결과 수락, 취소, 표시, 전체 취소 등 다양한 상태 변화를 처리합니다.
 * //TODO:KJM https://app.posthog.com로 로그 전송한다. 불필요 해보이기때문에 나중에 제거할 예정
 */
export class AutocompleteLoggingService {
  // Key is completionId
  private _abortControllers = new Map<string, AbortController>();
  private _logRejectionTimeouts = new Map<string, NodeJS.Timeout>();
  private _outcomes = new Map<string, AutocompleteOutcome>();
  _lastDisplayedCompletion: { id: string; displayedAt: number } | undefined =
    undefined;

  /**
   * 자동완성 요청에 대한 AbortController를 생성합니다.
   * @param completionId
   * @returns
   */
  public createAbortController(completionId: string): AbortController {
    const abortController = new AbortController();
    this._abortControllers.set(completionId, abortController);
    return abortController;
  }

  /**
   * 자동완성 요청에 대한 AbortController를 가져옵니다.
   * @param completionId - 자동완성 요청의 고유 ID입니다.
   * @returns 해당 ID에 대한 AbortController 객체입니다. 없으면 undefined를 반환합니다.
   */
  public deleteAbortController(completionId: string) {
    this._abortControllers.delete(completionId);
  }

  /**
   * 자동완성 요청을 취소합니다.
   * 모든 AbortController를 abort하고, 관련된 타임아웃과 결과를 정리합니다.
   */
  public cancel() {
    this._abortControllers.forEach((abortController, id) => {
      abortController.abort();
    });
    this._abortControllers.clear();
  }

  /**
   * 자동완성 결과를 수락합니다.
   * @param completionId - 자동완성 요청의 고유 ID입니다.
   * @returns 수락된 자동완성 결과 객체입니다. 없으면 undefined를 반환합니다.
   */
  public accept(completionId: string): AutocompleteOutcome | undefined {
    if (this._logRejectionTimeouts.has(completionId)) {
      clearTimeout(this._logRejectionTimeouts.get(completionId));
      this._logRejectionTimeouts.delete(completionId);
    }

    if (this._outcomes.has(completionId)) {
      const outcome = this._outcomes.get(completionId)!;
      outcome.accepted = true;
      this.logAutocompleteOutcome(outcome);
      this._outcomes.delete(completionId);
      return outcome;
    }
  }

  /**
   * 자동완성 결과를 거절합니다.
   * @param completionId - 자동완성 요청의 고유 ID입니다.
   */
  public cancelRejectionTimeout(completionId: string) {
    if (this._logRejectionTimeouts.has(completionId)) {
      clearTimeout(this._logRejectionTimeouts.get(completionId)!);
      this._logRejectionTimeouts.delete(completionId);
    }

    if (this._outcomes.has(completionId)) {
      this._outcomes.delete(completionId);
    }
  }

  /**
   * 자동완성 결과가 표시되었음을 마크합니다.
   * @param completionId - 자동완성 요청의 고유 ID입니다.
   * @param outcome - 자동완성 결과 객체입니다.
   */
  public markDisplayed(completionId: string, outcome: AutocompleteOutcome) {
    const logRejectionTimeout = setTimeout(() => {
      // Wait 10 seconds, then assume it wasn't accepted
      outcome.accepted = false;
      this.logAutocompleteOutcome(outcome);
      this._logRejectionTimeouts.delete(completionId);
    }, COUNT_COMPLETION_REJECTED_AFTER);
    this._outcomes.set(completionId, outcome);
    this._logRejectionTimeouts.set(completionId, logRejectionTimeout);

    // If the previously displayed completion is still waiting for rejection,
    // and this one is a continuation of that (the outcome.completion is the same modulo prefix)
    // then we should cancel the rejection timeout
    const previous = this._lastDisplayedCompletion;
    const now = Date.now();
    if (previous && this._logRejectionTimeouts.has(previous.id)) {
      const previousOutcome = this._outcomes.get(previous.id);
      const c1 = previousOutcome?.completion.split("\n")[0] ?? "";
      const c2 = outcome.completion.split("\n")[0];
      if (
        previousOutcome &&
        (c1.endsWith(c2) ||
          c2.endsWith(c1) ||
          c1.startsWith(c2) ||
          c2.startsWith(c1))
      ) {
        this.cancelRejectionTimeout(previous.id);
      } else if (now - previous.displayedAt < 500) {
        // If a completion isn't shown for more than
        this.cancelRejectionTimeout(previous.id);
      }
    }

    this._lastDisplayedCompletion = {
      id: completionId,
      displayedAt: now,
    };
  }

  /**
   * 자동완성 결과를 로깅합니다. [https://app.posthog.com로 로그 전송]
   * @param outcome - 자동완성 결과 객체입니다.
   */
  private logAutocompleteOutcome(outcome: AutocompleteOutcome) {
    void DataLogger.getInstance().logDevData({
      name: "autocomplete",
      data: {
        ...outcome,
        useFileSuffix: true, // from outdated schema
      },
    });

    const { prompt, completion, prefix, suffix, ...restOfOutcome } = outcome;
    void Telemetry.capture(
      "autocomplete",
      {
        accepted: restOfOutcome.accepted,
        cacheHit: restOfOutcome.cacheHit,
        completionId: restOfOutcome.completionId,
        completionOptions: restOfOutcome.completionOptions,
        debounceDelay: restOfOutcome.debounceDelay,
        fileExtension: getUriFileExtension(restOfOutcome.filepath),
        maxPromptTokens: restOfOutcome.maxPromptTokens,
        modelName: restOfOutcome.modelName,
        modelProvider: restOfOutcome.modelProvider,
        multilineCompletions: restOfOutcome.multilineCompletions,
        time: restOfOutcome.time,
        useRecentlyEdited: restOfOutcome.useRecentlyEdited,
        numLines: restOfOutcome.numLines,
      },
      true,
    );
  }
}
