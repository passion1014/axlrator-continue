import * as fs from "fs/promises";

import { ConfigHandler } from "../config/ConfigHandler.js";
import { IContinueServerClient } from "../continueServer/interface.js";
import { IDE, IndexingProgressUpdate, IndexTag } from "../index.js";
import { extractMinimalStackTraceInfo } from "../util/extractMinimalStackTraceInfo.js";
import { getIndexSqlitePath, getLanceDbPath } from "../util/paths.js";
import { findUriInDirs, getUriPathBasename } from "../util/uri.js";

import { LLMError } from "../llm/index.js";
import { getRootCause } from "../util/errors.js";
import { ChunkCodebaseIndex } from "./chunk/ChunkCodebaseIndex.js";
import { CodeSnippetsCodebaseIndex } from "./CodeSnippetsIndex.js";
import { FullTextSearchCodebaseIndex } from "./FullTextSearchCodebaseIndex.js";
import { LanceDbIndex } from "./LanceDbIndex.js";
import { getComputeDeleteAddRemove } from "./refreshIndex.js";
import {
  CodebaseIndex,
  IndexResultType,
  PathAndCacheKey,
  RefreshIndexResults,
} from "./types.js";
import { walkDirAsync } from "./walkDir.js";

/**
 * PauseToken 클래스는 인덱싱 작업을 일시정지하고 재개할 수 있는 기능을 제공합니다.
 * - paused 속성을 통해 인덱싱 작업의 일시정지 상태를 제어합니다.
 * - 인덱싱 작업 중 일시정지 및 재개를 지원합니다.
 */
export class PauseToken {
  constructor(private _paused: boolean) {}

  set paused(value: boolean) {
    this._paused = value;
  }

  get paused(): boolean {
    return this._paused;
  }
}

/**
 * CodebaseIndexer 클래스는 코드베이스의 파일들을 인덱싱하고, 인덱스의 생성, 갱신, 삭제를 관리합니다.
 *
 * 주요 기능:
 * - 대용량 파일 인덱싱 시 메모리 사용량을 제한하고, 임베딩 제공자에게 요청 횟수를 최소화하기 위해 배치 단위로 처리합니다.
 * - 특정 Sqlite 에러 발생 시 인덱스를 자동으로 초기화할 수 있습니다.
 * - 파일 또는 디렉터리 단위로 인덱싱을 수행하며, 진행 상황을 AsyncGenerator로 제공합니다.
 * - 인덱싱 중 일시정지 및 취소 기능을 지원합니다.
 * - 다양한 인덱스(임베딩, FTS, 코드 스니펫 등)를 동적으로 생성 및 갱신합니다.
 *
 * 생성자 매개변수:
 * @param configHandler - 인덱싱 설정을 로드하는 핸들러
 * @param ide - IDE와의 상호작용을 위한 객체
 * @param pauseToken - 인덱싱 일시정지/재개 제어 토큰
 * @param continueServerClient - 서버와의 통신을 위한 클라이언트
 *
 * 기타:
 * - 인덱싱 중 에러 발생 시, 에러 메시지와 함께 인덱스 초기화 필요 여부를 판단합니다.
 * - 인덱싱 진행률, 속도 등 로그를 출력할 수 있습니다.
 */
export class CodebaseIndexer {
  /**
   * We batch for two reasons:
   * - To limit memory usage for indexes that perform computations locally, e.g. FTS
   * - To make as few requests as possible to the embeddings providers
   */
  filesPerBatch = 500;

  // Note that we exclude certain Sqlite errors that we do not want to clear the indexes on,
  // e.g. a `SQLITE_BUSY` error.
  errorsRegexesToClearIndexesOn = [
    /Invalid argument error: Values length (d+) is less than the length ((d+)) multiplied by the value size (d+)/,
    /SQLITE_CONSTRAINT/,
    /SQLITE_ERROR/,
    /SQLITE_CORRUPT/,
    /SQLITE_IOERR/,
    /SQLITE_FULL/,
  ];

  /**
   * CodebaseIndexer 생성자
   * @param configHandler - 인덱싱 설정을 로드하는 핸들러
   * @param ide - IDE와의 상호작용을 위한 객체
   * @param pauseToken - 인덱싱 일시정지/재개 제어 토큰
   * @param continueServerClient - 서버와의 통신을 위한 클라이언트
   */
  constructor(
    private readonly configHandler: ConfigHandler,
    protected readonly ide: IDE,
    private readonly pauseToken: PauseToken,
    private readonly continueServerClient: IContinueServerClient,
  ) {}

  /**
   * 인덱스 파일 및 LanceDB 폴더를 삭제합니다.
   * - 인덱스 파일은 getIndexSqlitePath()를 통해 경로를 가져옵니다.
   * - LanceDB 폴더는 getLanceDbPath()를 통해 경로를 가져옵니다.
   */
  async clearIndexes() {
    const sqliteFilepath = getIndexSqlitePath();
    const lanceDbFolder = getLanceDbPath();

    try {
      await fs.unlink(sqliteFilepath);
    } catch (error) {
      console.error(`Error deleting ${sqliteFilepath} folder: ${error}`);
    }

    try {
      await fs.rm(lanceDbFolder, { recursive: true, force: true });
    } catch (error) {
      console.error(`Error deleting ${lanceDbFolder}: ${error}`);
    }
  }

  /**
   * 현재 설정에 따라 생성할 인덱스 목록을 반환합니다.
   * - 임베딩 인덱스는 항상 첫 번째로 생성됩니다.
   * - LanceDB 인덱스가 존재하면 추가됩니다.
   * - 전체 텍스트 검색 인덱스와 코드 스니펫 인덱스가 추가됩니다.
   * @returns Promise<CodebaseIndex[]> 생성할 인덱스 목록
   */
  protected async getIndexesToBuild(): Promise<CodebaseIndex[]> {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const embeddingsModel = config.selectedModelByRole.embed;
    if (!embeddingsModel) {
      return [];
    }

    const indexes: CodebaseIndex[] = [
      new ChunkCodebaseIndex(
        this.ide.readFile.bind(this.ide),
        this.continueServerClient,
        embeddingsModel.maxEmbeddingChunkSize,
      ), // Chunking must come first
    ];

    const lanceDbIndex = await LanceDbIndex.create(
      embeddingsModel,
      this.ide.readFile.bind(this.ide),
    );

    if (lanceDbIndex) {
      indexes.push(lanceDbIndex);
    }

    indexes.push(
      new FullTextSearchCodebaseIndex(),
      new CodeSnippetsCodebaseIndex(this.ide),
    );

    return indexes;
  }

  /**
   * 인덱싱 결과에서 총 인덱스 작업 수를 계산합니다.
   * @param results - 인덱싱 결과 객체
   * @returns 총 인덱스 작업 수
   */
  private totalIndexOps(results: RefreshIndexResults): number {
    return (
      results.compute.length +
      results.del.length +
      results.addTag.length +
      results.removeTag.length
    );
  }

  /**
   * 지정된 파일에 대한 인덱싱 결과를 필터링합니다.
   * @param results - 인덱싱 결과 객체
   * @param lastUpdated - 마지막 갱신된 파일 경로와 캐시 키 목록
   * @param filePath - 필터링할 파일 경로
   * @returns 필터링된 인덱싱 결과와 마지막 갱신된 파일 목록
   */
  private singleFileIndexOps(
    results: RefreshIndexResults,
    lastUpdated: PathAndCacheKey[],
    filePath: string,
  ): [RefreshIndexResults, PathAndCacheKey[]] {
    const filterFn = (item: PathAndCacheKey) => item.path === filePath;
    const compute = results.compute.filter(filterFn);
    const del = results.del.filter(filterFn);
    const addTag = results.addTag.filter(filterFn);
    const removeTag = results.removeTag.filter(filterFn);
    const newResults = {
      compute,
      del,
      addTag,
      removeTag,
    };
    const newLastUpdated = lastUpdated.filter(filterFn);
    return [newResults, newLastUpdated];
  }

  /**
   * 지정된 파일의 인덱스를 갱신합니다.
   * @param file - 갱신할 파일 경로
   * @param workspaceDirs - 워크스페이스 디렉터리 목록
   */
  public async refreshFile(
    file: string,
    workspaceDirs: string[],
  ): Promise<void> {
    if (this.pauseToken.paused) {
      // NOTE: by returning here, there is a chance that while paused a file is modified and
      // then after unpausing the file is not reindexed
      return;
    }
    const { foundInDir } = findUriInDirs(file, workspaceDirs);
    if (!foundInDir) {
      return;
    }
    const branch = await this.ide.getBranch(foundInDir);
    const repoName = await this.ide.getRepoName(foundInDir);
    const indexesToBuild = await this.getIndexesToBuild();
    const stats = await this.ide.getFileStats([file]);
    const filePath = Object.keys(stats)[0];
    for (const index of indexesToBuild) {
      const tag = {
        directory: foundInDir,
        branch,
        artifactId: index.artifactId,
      };
      const [fullResults, fullLastUpdated, markComplete] =
        await getComputeDeleteAddRemove(
          tag,
          { ...stats },
          (filepath) => this.ide.readFile(filepath),
          repoName,
        );

      const [results, lastUpdated] = this.singleFileIndexOps(
        fullResults,
        fullLastUpdated,
        filePath,
      );
      // Don't update if nothing to update. Some of the indices might do unnecessary setup work
      if (this.totalIndexOps(results) + lastUpdated.length === 0) {
        continue;
      }

      for await (const _ of index.update(
        tag,
        results,
        markComplete,
        repoName,
      )) {
      }
    }
  }

  /**
   * 지정된 파일 목록에 대해 인덱싱을 수행하며, 진행 상황을 반환합니다.
   * @param files - 인덱싱할 파일 목록
   */
  async *refreshFiles(files: string[]): AsyncGenerator<IndexingProgressUpdate> {
    let progress = 0;
    if (files.length === 0) {
      yield {
        progress: 1,
        desc: "Indexing Complete",
        status: "done",
      };
    }

    const workspaceDirs = await this.ide.getWorkspaceDirs();

    const progressPer = 1 / files.length;
    try {
      for (const file of files) {
        yield {
          progress,
          desc: `Indexing file ${file}...`,
          status: "indexing",
        };
        await this.refreshFile(file, workspaceDirs);

        progress += progressPer;

        if (this.pauseToken.paused) {
          yield* this.yieldUpdateAndPause();
        }
      }

      yield {
        progress: 1,
        desc: "Indexing Complete",
        status: "done",
      };
    } catch (err) {
      yield this.handleErrorAndGetProgressUpdate(err);
    }
  }

  /**
   * 디렉터리 내 모든 파일을 인덱싱하며, 진행 상황을 반환합니다.
   * @param dirs - 인덱싱할 디렉터리 목록
   * @param abortSignal - 인덱싱 취소를 위한 AbortSignal
   */
  async *refreshDirs(
    dirs: string[],
    abortSignal: AbortSignal,
  ): AsyncGenerator<IndexingProgressUpdate> {
    let progress = 0;

    if (dirs.length === 0) {
      yield {
        progress: 1,
        desc: "Nothing to index",
        status: "done",
      };
      return;
    }

    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return;
    }
    if (config.disableIndexing) {
      yield {
        progress,
        desc: "Indexing is disabled in config.json",
        status: "disabled",
      };
      return;
    } else {
      yield {
        progress,
        desc: "Starting indexing",
        status: "loading",
      };
    }

    // Wait until Git Extension has loaded to report progress
    // so we don't appear stuck at 0% while waiting
    await this.ide.getRepoName(dirs[0]);

    yield {
      progress,
      desc: "Starting indexing...",
      status: "loading",
    };
    const beginTime = Date.now();

    for (const directory of dirs) {
      const dirBasename = getUriPathBasename(directory);
      yield {
        progress,
        desc: `Discovering files in ${dirBasename}...`,
        status: "indexing",
      };
      const directoryFiles = [];
      for await (const p of walkDirAsync(directory, this.ide, {
        source: "codebase indexing: refresh dirs",
      })) {
        directoryFiles.push(p);
        if (abortSignal.aborted) {
          yield {
            progress: 0,
            desc: "Indexing cancelled",
            status: "cancelled",
          };
          return;
        }
        if (this.pauseToken.paused) {
          yield* this.yieldUpdateAndPause();
        }
      }

      const branch = await this.ide.getBranch(directory);
      const repoName = await this.ide.getRepoName(directory);
      let nextLogThreshold = 0;

      try {
        for await (const updateDesc of this.indexFiles(
          directory,
          directoryFiles,
          branch,
          repoName,
        )) {
          // Handle pausing in this loop because it's the only one really taking time
          if (abortSignal.aborted) {
            yield {
              progress: 0,
              desc: "Indexing cancelled",
              status: "cancelled",
            };
            return;
          }
          if (this.pauseToken.paused) {
            yield* this.yieldUpdateAndPause();
          }
          yield updateDesc;
          if (updateDesc.progress >= nextLogThreshold) {
            // log progress every 2.5%
            nextLogThreshold += 0.025;
            this.logProgress(
              beginTime,
              Math.floor(directoryFiles.length * updateDesc.progress),
              updateDesc.progress,
            );
          }
        }
      } catch (err) {
        yield this.handleErrorAndGetProgressUpdate(err);
        return;
      }
    }
    yield {
      progress: 1,
      desc: "Indexing Complete",
      status: "done",
    };
    this.logProgress(beginTime, 0, 1);
  }

  /**
   * 인덱싱 중 에러가 발생했을 때, 에러를 처리하고 인덱싱 진행 상황 업데이트를 반환합니다.
   * @param err - 발생한 에러
   * @returns IndexingProgressUpdate 객체
   */
  private handleErrorAndGetProgressUpdate(
    err: unknown,
  ): IndexingProgressUpdate {
    console.log("error when indexing: ", err);
    if (err instanceof Error) {
      const cause = getRootCause(err);
      if (cause instanceof LLMError) {
        throw cause;
      }
      return this.errorToProgressUpdate(err);
    }
    return {
      progress: 0,
      desc: `Indexing failed: ${err}`,
      status: "failed",
      debugInfo: extractMinimalStackTraceInfo((err as any)?.stack),
    };
  }

  /**
   * 에러를 인덱싱 진행 상황 업데이트로 변환합니다.
   * @param err - 발생한 에러
   * @returns IndexingProgressUpdate 객체
   */
  private errorToProgressUpdate(err: Error): IndexingProgressUpdate {
    const cause = getRootCause(err);
    let errMsg: string = `${cause}`;
    let shouldClearIndexes = false;

    // Check if any of the error regexes match
    for (const regexStr of this.errorsRegexesToClearIndexesOn) {
      const regex = new RegExp(regexStr);
      const match = err.message.match(regex);

      if (match !== null) {
        shouldClearIndexes = true;
        break;
      }
    }

    return {
      progress: 0,
      desc: errMsg,
      status: "failed",
      shouldClearIndexes,
      debugInfo: extractMinimalStackTraceInfo(err.stack),
    };
  }

  /**
   * 인덱싱 진행 상황을 로그로 출력합니다.
   * @param beginTime - 인덱싱 시작 시간 (밀리초 단위)
   * @param completedFileCount - 완료된 파일 수
   * @param progress - 현재 진행률 (0.0 ~ 1.0)
   */
  private logProgress(
    beginTime: number,
    completedFileCount: number,
    progress: number,
  ) {
    const timeTaken = Date.now() - beginTime;
    const seconds = Math.round(timeTaken / 1000);
    const progressPercentage = (progress * 100).toFixed(1);
    const filesPerSec = (completedFileCount / seconds).toFixed(2);
    // console.debug(
    //   `Indexing: ${progressPercentage}% complete, elapsed time: ${seconds}s, ${filesPerSec} file/sec`,
    // );
  }

  /**
   * 인덱싱이 일시정지된 상태에서 업데이트를 생성하고, 일시정지 상태를 유지합니다.
   * @returns AsyncGenerator<IndexingProgressUpdate>
   */
  private async *yieldUpdateAndPause(): AsyncGenerator<IndexingProgressUpdate> {
    yield {
      progress: 0,
      desc: "Indexing Paused",
      status: "paused",
    };
    while (this.pauseToken.paused) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * 인덱싱 결과를 배치 단위로 분할합니다.
   * 대규모 저장소에서 인덱싱 시 메모리 사용량을 제한하기 위해 결과를 배치로 나눕니다.
   * @param results 인덱싱 결과 객체
   */
  private *batchRefreshIndexResults(
    results: RefreshIndexResults,
  ): Generator<RefreshIndexResults> {
    let curPos = 0;
    while (
      curPos < results.compute.length ||
      curPos < results.del.length ||
      curPos < results.addTag.length ||
      curPos < results.removeTag.length
    ) {
      yield {
        compute: results.compute.slice(curPos, curPos + this.filesPerBatch),
        del: results.del.slice(curPos, curPos + this.filesPerBatch),
        addTag: results.addTag.slice(curPos, curPos + this.filesPerBatch),
        removeTag: results.removeTag.slice(curPos, curPos + this.filesPerBatch),
      };
      curPos += this.filesPerBatch;
    }
  }

  /**
   * 지정된 파일 목록에 대해 인덱싱을 수행합니다.
   * @param directory - 인덱싱할 디렉터리 경로
   * @param files - 인덱싱할 파일 목록
   * @param branch - 인덱싱할 브랜치
   * @param repoName - 인덱싱할 레포지토리 이름
   */
  private async *indexFiles(
    directory: string,
    files: string[],
    branch: string,
    repoName: string | undefined,
  ): AsyncGenerator<IndexingProgressUpdate> {
    const stats = await this.ide.getFileStats(files);
    const indexesToBuild = await this.getIndexesToBuild();
    let completedIndexCount = 0;
    let progress = 0;
    for (const codebaseIndex of indexesToBuild) {
      const tag: IndexTag = {
        directory,
        branch,
        artifactId: codebaseIndex.artifactId,
      };
      yield {
        progress: progress,
        desc: `Planning changes for ${codebaseIndex.artifactId} index...`,
        status: "indexing",
      };
      const [results, lastUpdated, markComplete] =
        await getComputeDeleteAddRemove(
          tag,
          { ...stats },
          (filepath) => this.ide.readFile(filepath),
          repoName,
        );
      const totalOps = this.totalIndexOps(results);
      let completedOps = 0;

      // Don't update if nothing to update. Some of the indices might do unnecessary setup work
      if (totalOps > 0) {
        for (const subResult of this.batchRefreshIndexResults(results)) {
          for await (const { desc } of codebaseIndex.update(
            tag,
            subResult,
            markComplete,
            repoName,
          )) {
            yield {
              progress: progress,
              desc,
              status: "indexing",
            };
          }
          completedOps +=
            subResult.compute.length +
            subResult.del.length +
            subResult.addTag.length +
            subResult.removeTag.length;
          progress =
            (completedIndexCount + completedOps / totalOps) *
            (1 / indexesToBuild.length);
        }
      }

      await markComplete(lastUpdated, IndexResultType.UpdateLastUpdated);
      completedIndexCount += 1;
    }
  }
}
