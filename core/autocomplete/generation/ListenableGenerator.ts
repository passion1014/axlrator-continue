/**
 * ListenableGenerator는 비동기 생성자(AsyncGenerator)로,
 * 값이 생성될 때마다 리스너를 등록하여 알림을 받을 수 있습니다.
 */
export class ListenableGenerator<T> {
  private _source: AsyncGenerator<T>;
  private _buffer: T[] = [];
  private _listeners: Set<(value: T) => void> = new Set();
  private _isEnded = false;
  private _abortController: AbortController;

  constructor(
    source: AsyncGenerator<T>,
    private readonly onError: (e: any) => void,
    abortController: AbortController,
  ) {
    this._source = source;
    this._abortController = abortController;
    this._start().catch((e) =>
      console.log(`Listenable generator failed: ${e.message}`),
    );
  }

  /**
   * 취소 메서드는 생성기를 중단하고 모든 리스너에게 종료를 알립니다.
   */
  public cancel() {
    this._abortController.abort();
    this._isEnded = true;
  }

  /**
   * _start 메서드는 생성기를 시작하고, 값이 생성될 때마다 리스너에게 알립니다.
   * 생성기가 끝나면 모든 리스너에게 null을 전달하여 종료를 알립니다.
   */
  private async _start() {
    try {
      for await (const value of this._source) {
        if (this._isEnded) {
          break;
        }
        this._buffer.push(value);
        for (const listener of this._listeners) {
          listener(value);
        }
      }
    } catch (e) {
      this.onError(e);
    } finally {
      this._isEnded = true;
      for (const listener of this._listeners) {
        listener(null as any);
      }
    }
  }

  /**
   * listen 메서드는 리스너를 등록하고, 이미 생성된 값을 즉시 전달합니다.
   * 생성기가 끝나면 null을 전달하여 종료를 알립니다.
   * @param listener - 값을 받을 리스너 함수
   */
  listen(listener: (value: T) => void) {
    this._listeners.add(listener);
    for (const value of this._buffer) {
      listener(value);
    }
    if (this._isEnded) {
      listener(null as any);
    }
  }

  /**
   * tee 메서드는 생성된 값을 비동기적으로 반환하는 이터레이터를 반환합니다.
   * 이 메서드는 생성기가 끝날 때까지 계속해서 값을 반환합니다.
   */
  async *tee(): AsyncGenerator<T> {
    try {
      let i = 0;
      while (i < this._buffer.length) {
        yield this._buffer[i++];
      }
      while (!this._isEnded) {
        let resolve: (value: any) => void;
        const promise = new Promise<T>((res) => {
          resolve = res;
          this._listeners.add(resolve!);
        });
        await promise;
        this._listeners.delete(resolve!);

        // Possible timing caused something to slip in between
        // timers so we iterate over the buffer
        while (i < this._buffer.length) {
          yield this._buffer[i++];
        }
      }
    } finally {
      // this._listeners.delete(resolve!);
    }
  }
}
