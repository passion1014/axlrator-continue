import { MessageIde } from "core/protocol/messenger/messageIde";
import { TODO } from "core/util";

/**
 * IpcIde는 IPC를 통해 메시지를 전송하고 수신하는 IDE 클래스입니다.
 */
export class IpcIde extends MessageIde {
  constructor(messenger: TODO) {
    super(messenger.request.bind(messenger), messenger.on.bind(messenger));
  }
}
