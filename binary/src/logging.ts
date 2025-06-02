import { getCoreLogsPath } from "core/util/paths";
import fs from "node:fs";

/**
 * 코어 로그를 설정합니다.
 * 로그는 지정된 경로에 타임스탬프와 함께 기록됩니다.
 */
export function setupCoreLogging() {
  const logger = (message: any, ...optionalParams: any[]) => {
    const logFilePath = getCoreLogsPath();
    const timestamp = new Date().toISOString().split(".")[0];
    const logMessage = `[${timestamp}] ${message} ${optionalParams.join(" ")}\n`;
    fs.appendFileSync(logFilePath, logMessage);
  };
  console.log = logger;
  console.error = logger;
  console.warn = logger;
  console.debug = logger;
  console.log("[info] Starting Continue core...");
}
