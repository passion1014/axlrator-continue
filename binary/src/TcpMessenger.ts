import { IProtocol } from "core/protocol";
import { IMessenger, Message } from "core/protocol/messenger";
import net from "net";
import { v4 as uuidv4 } from "uuid";

/**
 * TcpMessenger는 TCP 소켓을 통해 메시지를 전송하고 수신하는 메신저 클래스입니다.
 * 이 클래스는 ToProtocol과 FromProtocol을 사용하여 메시지 타입을 정의합니다.
 *
 * @typeParam ToProtocol - 코어로 전송되는 메시지의 타입입니다.
 * @typeParam FromProtocol - 코어에서 수신되는 메시지의 타입입니다.
 */
export class TcpMessenger<
  ToProtocol extends IProtocol,
  FromProtocol extends IProtocol,
> implements IMessenger<ToProtocol, FromProtocol>
{
  private port: number = 3000;
  private host: string = "127.0.0.1";
  private socket: net.Socket | null = null;

  typeListeners = new Map<keyof ToProtocol, ((message: Message) => any)[]>();
  idListeners = new Map<string, (message: Message) => any>();

  constructor() {
    const server = net.createServer((socket) => {
      this.socket = socket;

      socket.on("connect", () => {
        console.log("Connected to server");
      });

      socket.on("data", (data: Buffer) => {
        this._handleData(data);
      });

      socket.on("end", () => {
        console.log("Disconnected from server");
      });

      socket.on("error", (err: any) => {
        console.error("Client error:", err);
      });
    });

    server.listen(this.port, this.host, () => {
      console.log(`Server listening on port ${this.port}`);
    });
  }

  private _onErrorHandlers: ((message: Message, error: Error) => void)[] = [];

  /**
   * onError 메서드는 메시지 처리 중 발생한 오류를 처리하는 핸들러를 등록합니다.
   * 이 핸들러는 메시지와 오류 객체를 인자로 받습니다.
   *
   * @param handler - 메시지와 오류 객체를 인자로 받는 핸들러 함수
   */
  onError(handler: (message: Message, error: Error) => void) {
    this._onErrorHandlers.push(handler);
  }

  /**
   * awaitConnection 메서드는 소켓이 연결될 때까지 대기합니다.
   * 이 메서드는 비동기적으로 작동하며, 소켓이 연결되면 반환됩니다.
   */
  public async awaitConnection() {
    while (!this.socket) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * _handleLine 메서드는 수신된 한 줄의 메시지를 처리합니다.
   * 메시지를 JSON으로 파싱하고, 해당 메시지 타입에 대한 핸들러를 호출합니다.
   *
   * @param line - 수신된 메시지의 한 줄
   */
  private _handleLine(line: string) {
    try {
      const msg: Message = JSON.parse(line);
      if (msg.messageType === undefined || msg.messageId === undefined) {
        throw new Error("Invalid message sent: " + JSON.stringify(msg));
      }

      // Call handler and respond with return value
      const listeners = this.typeListeners.get(msg.messageType as any);
      listeners?.forEach(async (handler) => {
        try {
          const response = await handler(msg);
          if (
            response &&
            typeof response[Symbol.asyncIterator] === "function"
          ) {
            let next = await response.next();
            while (!next.done) {
              this.send(
                msg.messageType,
                {
                  done: false,
                  content: next.value,
                  status: "success",
                },
                msg.messageId,
              );
              next = await response.next();
            }
            this.send(
              msg.messageType,
              {
                done: true,
                content: next.value,
                status: "success",
              },
              msg.messageId,
            );
          } else {
            this.send(
              msg.messageType,
              {
                done: true,
                content: response,
                status: "success",
              },
              msg.messageId,
            );
          }
        } catch (e: any) {
          this.send(
            msg.messageType,
            { done: true, error: e.message, status: "error" },
            msg.messageId,
          );

          console.warn(`Error running handler for "${msg.messageType}": `, e);
          this._onErrorHandlers.forEach((handler) => {
            handler(msg, e);
          });
        }
      });

      // Call handler which is waiting for the response, nothing to return
      this.idListeners.get(msg.messageId)?.(msg);
    } catch (e) {
      let truncatedLine = line;
      if (line.length > 200) {
        truncatedLine =
          line.substring(0, 100) + "..." + line.substring(line.length - 100);
      }
      console.error("Error parsing line: ", truncatedLine, e);
      return;
    }
  }

  private _unfinishedLine: string | undefined = undefined;

  /**
   * _handleData 메서드는 수신된 데이터를 처리합니다.
   * 데이터를 문자열로 변환하고, 줄 단위로 분리하여 각 줄을 처리합니다.
   *
   * @param data - 수신된 데이터 버퍼
   */
  private _handleData(data: Buffer) {
    const d = data.toString();
    const lines = d.split(/\r\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      return;
    }

    if (this._unfinishedLine) {
      lines[0] = this._unfinishedLine + lines[0];
      this._unfinishedLine = undefined;
    }
    if (!d.endsWith("\r\n")) {
      this._unfinishedLine = lines.pop();
    }
    lines.forEach((line) => this._handleLine(line));
  }

  /**
   * send 메서드는 지정된 메시지 타입과 데이터를 사용하여 메시지를 전송합니다.
   * 메시지는 JSON 문자열로 변환되어 소켓을 통해 전송됩니다.
   *
   * @param messageType - 전송할 메시지의 타입
   * @param data - 전송할 데이터
   * @param messageId - (선택적) 메시지 ID, 지정하지 않으면 UUID가 생성됩니다.
   * @returns 전송된 메시지의 ID
   */
  send<T extends keyof FromProtocol>(
    messageType: T,
    data: FromProtocol[T][0],
    messageId?: string,
  ): string {
    messageId = messageId ?? uuidv4();
    const msg: Message = {
      messageType: messageType as string,
      data,
      messageId,
    };

    this.socket?.write(JSON.stringify(msg) + "\r\n");
    return messageId;
  }

  /**
   * on 메서드는 지정된 메시지 타입에 대한 핸들러를 등록합니다.
   * 이 핸들러는 메시지를 수신할 때 호출됩니다.
   *
   * @param messageType - 메시지 타입
   * @param handler - 메시지를 처리하는 핸들러 함수
   */
  on<T extends keyof ToProtocol>(
    messageType: T,
    handler: (message: Message<ToProtocol[T][0]>) => ToProtocol[T][1],
  ): void {
    if (!this.typeListeners.has(messageType)) {
      this.typeListeners.set(messageType, []);
    }
    this.typeListeners.get(messageType)?.push(handler);
  }

  /**
   * invoke 메서드는 지정된 메시지 타입과 데이터를 사용하여 메시지를 전송하고,
   * 해당 메시지 타입에 대한 첫 번째 핸들러의 반환 값을 반환합니다.
   *
   * @param messageType - 전송할 메시지의 타입
   * @param data - 전송할 데이터
   * @returns 핸들러의 반환 값
   */
  invoke<T extends keyof ToProtocol>(
    messageType: T,
    data: ToProtocol[T][0],
  ): ToProtocol[T][1] {
    return this.typeListeners.get(messageType)?.[0]?.({
      messageId: uuidv4(),
      messageType: messageType as string,
      data,
    });
  }

  /**
   * request 메서드는 지정된 메시지 타입과 데이터를 사용하여 메시지를 전송하고,
   * 해당 메시지 ID에 대한 응답을 기다립니다.
   *
   * @param messageType - 전송할 메시지의 타입
   * @param data - 전송할 데이터
   * @returns 응답 데이터
   */
  request<T extends keyof FromProtocol>(
    messageType: T,
    data: FromProtocol[T][0],
  ): Promise<FromProtocol[T][1]> {
    const messageId = uuidv4();
    return new Promise((resolve) => {
      const handler = (msg: Message) => {
        resolve(msg.data);
        this.idListeners.delete(messageId);
      };
      this.idListeners.set(messageId, handler);
      this.send(messageType, data, messageId);
    });
  }
}
