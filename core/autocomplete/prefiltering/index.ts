import ignore from "ignore";

import { IDE } from "../..";
import { getConfigJsonPath } from "../../util/paths";
import { findUriInDirs } from "../../util/uri";
import { HelperVars } from "../util/HelperVars";

/**
 * 현재 파일이 자동완성 비활성화 설정에 해당하는지 확인합니다.
 * @param currentFilepath - 현재 파일의 경로
 * @param disableInFiles - 자동완성 비활성화 설정이 포함된 파일 목록
 * @param ide - IDE 인스턴스
 * @returns {Promise<boolean>} - 파일이 비활성화 설정에 해당하면 true, 아니면 false
 */
async function isDisabledForFile(
  currentFilepath: string,
  disableInFiles: string[] | undefined,
  ide: IDE,
) {
  if (disableInFiles) {
    // Relative path needed for `ignore`
    const workspaceDirs = await ide.getWorkspaceDirs();
    const { relativePathOrBasename } = findUriInDirs(
      currentFilepath,
      workspaceDirs,
    );

    // @ts-ignore
    const pattern = ignore.default().add(disableInFiles);
    if (pattern.ignores(relativePathOrBasename)) {
      return true;
    }
  }
}

/**
 * 언어별로 자동완성 사전 필터링이 필요한지 확인합니다.
 * @param helper - 헬퍼 변수들
 * @returns {Promise<boolean>} - 언어별 필터링이 필요하면 true, 아니면 false
 */
async function shouldLanguageSpecificPrefilter(helper: HelperVars) {
  const line = helper.fileLines[helper.pos.line] ?? "";
  for (const endOfLine of helper.lang.endOfLine) {
    if (line.endsWith(endOfLine) && helper.pos.character >= line.length) {
      return true;
    }
  }
}

/**
 * 자동완성 사전 필터링을 수행합니다.
 * - config.json 파일이나 비활성화된 파일에서는 자동완성을 제공하지 않습니다.
 * - 빈 파일이나 untitled 파일에서는 자동완성을 제공하지 않습니다.
 * - 언어별로 사전 필터링이 필요한 경우 true를 반환합니다.
 * @param helper - 헬퍼 변수들
 * @param ide - IDE 인스턴스
 * @returns {Promise<boolean>} - 사전 필터링이 필요하면 true, 아니면 false
 */
export async function shouldPrefilter(
  helper: HelperVars,
  ide: IDE,
): Promise<boolean> {
  // Allow disabling autocomplete from config.json
  if (helper.options.disable) {
    return true;
  }

  // Check whether we're in the continue config.json file
  if (helper.filepath === getConfigJsonPath()) {
    return true;
  }

  // Check whether autocomplete is disabled for this file
  const disableInFiles = [...(helper.options.disableInFiles ?? []), "*.prompt"];
  if (await isDisabledForFile(helper.filepath, disableInFiles, ide)) {
    return true;
  }

  // Don't offer completions when we have no information (untitled file and no file contents)
  if (
    helper.filepath.includes("Untitled") &&
    helper.fileContents.trim() === ""
  ) {
    return true;
  }

  // if (
  //   helper.options.transform &&
  //   (await shouldLanguageSpecificPrefilter(helper))
  // ) {
  //   return true;
  // }

  return false;
}
