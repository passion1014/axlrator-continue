import { v4 as uuidv4 } from "uuid";

/**
 * AutocompleteDebouncer는 자동완성 요청에 대한 디바운싱을 관리하는 유틸리티 클래스입니다.
 * 지정된 지연 시간 후에 가장 최근의 요청만 처리되도록 보장합니다.
 */
export class AutocompleteDebouncer {
  private debounceTimeout: NodeJS.Timeout | undefined = undefined;
  private currentRequestId: string | undefined = undefined;

  async delayAndShouldDebounce(debounceDelay: number): Promise<boolean> {
    // 이 요청에 대한 고유 ID를 생성합니다
    const requestId = uuidv4();
    this.currentRequestId = requestId;

    // 기존 타임아웃이 있으면 제거합니다
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    // 디바운스 지연 후에 resolve되는 새로운 프로미스를 생성합니다
    return new Promise<boolean>((resolve) => {
      this.debounceTimeout = setTimeout(() => {
        // 타임아웃이 완료되면, 여전히 가장 최근의 요청인지 확인합니다
        const shouldDebounce = this.currentRequestId !== requestId;

        // 가장 최근의 요청이라면 디바운스하지 않아야 합니다
        if (!shouldDebounce) {
          this.currentRequestId = undefined;
        }

        resolve(shouldDebounce);
      }, debounceDelay);
    });
  }
}
