import { IProtocol } from "core/protocol/index.js";
import { IMessenger, type Message } from "core/protocol/messenger";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import net from "node:net";
import { v4 as uuidv4 } from "uuid";

/**
 * IPCMessengerBase 클래스는 IPC(프로세스 간 통신)를 위한 메신저의 기본 구현체입니다.
 *
 * @template ToProtocol 송신 프로토콜 타입
 * @template FromProtocol 수신 프로토콜 타입
 *
 * 이 클래스는 메시지 송수신, 핸들러 등록, 에러 처리, 비동기 응답 처리 등 IPC 통신에 필요한 핵심 기능을 제공합니다.
 *
 * @method _sendMsg(message) 실제 메시지 전송을 담당하는 메서드로, 하위 클래스에서 구현해야 합니다.
 * @method onError 에러 발생 시 호출될 핸들러를 등록합니다.
 * @method request 지정한 타입의 메시지를 보내고, 응답을 Promise로 반환합니다.
 * @method mock 테스트를 위해 데이터를 직접 주입하여 처리할 수 있습니다.
 * @method send 메시지를 전송합니다.
 * @method invoke 등록된 핸들러를 직접 호출합니다.
 * @method on 특정 메시지 타입에 대한 핸들러를 등록합니다.
 *
 * @property typeListeners 메시지 타입별로 등록된 핸들러 목록입니다.
 * @property idListeners 메시지 ID별로 등록된 핸들러 목록입니다.
 *
 * @remarks
 * - 메시지 핸들러는 비동기 함수도 지원하며, async generator를 반환할 경우 스트리밍 응답도 처리할 수 있습니다.
 * - 내부적으로 메시지 파싱, 에러 로깅, 미완성 라인 처리 등 안정적인 통신을 위한 다양한 기능이 포함되어 있습니다.
 */
class IPCMessengerBase<
  ToProtocol extends IProtocol,
  FromProtocol extends IProtocol,
> implements IMessenger<ToProtocol, FromProtocol>
{
  _sendMsg(message: Message) {
    throw new Error("Not implemented");
  }

  typeListeners = new Map<keyof ToProtocol, ((message: Message) => any)[]>();
  idListeners = new Map<string, (message: Message) => any>();

  /**
   * 수신된 메시지를 처리하는 메서드입니다.
   * @param line 수신된 메시지 라인
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
   * 수신된 데이터를 처리합니다. 데이터는 문자열로 변환되어 줄 단위로 분리됩니다.
   * 마지막 줄이 완전하지 않은 경우, 다음 데이터 수신 시 이어서 처리합니다.
   * @param data 수신된 데이터
   */
  protected _handleData(data: Buffer) {
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

  private _onErrorHandlers: ((message: Message, error: Error) => void)[] = [];

  onError(handler: (message: Message, error: Error) => void) {
    this._onErrorHandlers.push(handler);
  }

  /**
   * 지정한 메시지 타입에 대한 요청을 보내고, 응답을 Promise로 반환합니다.
   * @param messageType 요청할 메시지 타입
   * @param data 요청 데이터
   * @returns 응답 데이터의 Promise
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

  mock(data: any) {
    const d = JSON.stringify(data);
    this._handleData(Buffer.from(d));
  }

  /**
   * 지정한 메시지 타입과 데이터를 사용하여 메시지를 전송합니다.
   * @param messageType 전송할 메시지의 타입
   * @param data 전송할 데이터
   * @param messageId 선택적으로 지정할 메시지 ID
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
    this._sendMsg(msg);
    return messageId;
  }

  /**
   * 지정한 메시지 타입에 대한 핸들러를 직접 호출합니다.
   * @param messageType 호출할 메시지 타입
   * @param data 핸들러에 전달할 데이터
   * @returns 핸들러의 반환값
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
   * 지정한 메시지 타입에 대한 핸들러를 등록합니다.
   * @param messageType 등록할 메시지 타입
   * @param handler 해당 타입의 메시지를 처리할 핸들러 함수
   */
  on<T extends keyof ToProtocol>(
    messageType: T,
    handler: (
      message: Message<ToProtocol[T][0]>,
    ) => Promise<ToProtocol[T][1]> | ToProtocol[T][1],
  ): void {
    if (!this.typeListeners.has(messageType)) {
      this.typeListeners.set(messageType, []);
    }
    this.typeListeners.get(messageType)?.push(handler);
  }
}

/**
 * IpcMessenger 클래스는 IPC(프로세스 간 통신)를 위한 메신저 구현체입니다.
 */
export class IpcMessenger<
    ToProtocol extends IProtocol,
    FromProtocol extends IProtocol,
  >
  extends IPCMessengerBase<ToProtocol, FromProtocol>
  implements IMessenger<ToProtocol, FromProtocol>
{
  constructor() {
    super();
    console.log("Setup");
    process.stdin.on("data", (data) => {
      // console.log("[info] Received data: ", data.toString());
      this._handleData(data);
    });
    process.stdout.on("close", () => {
      fs.writeFileSync("./error.log", `${new Date().toISOString()}\n`);
      console.log("[info] Exiting Continue core...");
      process.exit(1);
    });
    process.stdin.on("close", () => {
      fs.writeFileSync("./error.log", `${new Date().toISOString()}\n`);
      console.log("[info] Exiting Continue core...");
      process.exit(1);
    });
  }

  _sendMsg(msg: Message) {
    const d = JSON.stringify(msg);
    // console.log("[info] Sending message: ", d);
    process.stdout?.write(d + "\r\n");
  }
}

/**
 * CoreBinaryMessenger 클래스는 Node.js의 Child Process를 사용하여 IPC(프로세스 간 통신)를 위한 메신저 구현체입니다.
 */
export class CoreBinaryMessenger<
    ToProtocol extends IProtocol,
    FromProtocol extends IProtocol,
  >
  extends IPCMessengerBase<ToProtocol, FromProtocol>
  implements IMessenger<ToProtocol, FromProtocol>
{
  private errorHandler: (message: Message, error: Error) => void = () => {};
  private messageHandlers: Map<
    keyof ToProtocol,
    (message: Message<any>) => Promise<any> | any
  > = new Map();

  /**
   * CoreBinaryMessenger 생성자
   * @param subprocess
   */
  constructor(private readonly subprocess: ChildProcessWithoutNullStreams) {
    super();
    console.log("Setup");
    this.subprocess.stdout.on("data", (data) => {
      console.log("[info] Received data from core:", data.toString() + "\n");
      this._handleData(data);
    });
    this.subprocess.stdout.on("close", () => {
      console.log("[info] Continue core exited");
    });
    this.subprocess.stdin.on("close", () => {
      console.log("[info] Continue core exited");
    });
  }

  _sendMsg(msg: Message) {
    console.log("[info] Sending message to core:", msg);
    const d = JSON.stringify(msg);
    this.subprocess.stdin.write(d + "\r\n");
  }
}

/**
 * CoreBinaryTcpMessenger 클래스는 TCP 소켓을 사용하여 IPC(프로세스 간 통신)를 위한 메신저 구현체입니다.
 */
export class CoreBinaryTcpMessenger<
    ToProtocol extends IProtocol,
    FromProtocol extends IProtocol,
  >
  extends IPCMessengerBase<ToProtocol, FromProtocol>
  implements IMessenger<ToProtocol, FromProtocol>
{
  private port: number = 3000;
  private socket: net.Socket | null = null;

  typeListeners = new Map<keyof ToProtocol, ((message: Message) => any)[]>();
  idListeners = new Map<string, (message: Message) => any>();

  constructor() {
    super();
    const socket = net.createConnection(this.port, "localhost");

    this.socket = socket;
    socket.on("data", (data: Buffer) => {
      // console.log("[info] Received data from core:", data.toString() + "\n");
      this._handleData(data);
    });

    socket.on("end", () => {
      console.log("Disconnected from server");
    });

    socket.on("error", (err: any) => {
      console.error("Client error:", err);
    });
  }

  close() {
    this.socket?.end();
  }

  _sendMsg(msg: Message) {
    if (this.socket) {
      // console.log("[info] Sending message to core:", msg);
      const d = JSON.stringify(msg);
      this.socket.write(d + "\r\n");
    } else {
      console.error("Socket is not connected");
    }
  }
}
