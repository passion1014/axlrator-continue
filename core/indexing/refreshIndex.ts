import crypto from "node:crypto";
import * as fs from "node:fs";

import plimit from "p-limit";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";

import { FileStatsMap, IndexTag, IndexingProgressUpdate } from "../index.js";
import { getIndexSqlitePath } from "../util/paths.js";

import {
  CodebaseIndex,
  IndexResultType,
  MarkCompleteCallback,
  PathAndCacheKey,
  RefreshIndexResults,
} from "./types.js";

export type DatabaseConnection = Database<sqlite3.Database>;

/**
 * SQLite 데이터베이스 클래스입니다.
 * 이 클래스는 데이터베이스 연결을 관리하고, 테이블을 생성하며, 인덱싱 작업을 수행합니다.
 */
export class SqliteDb {
  static db: DatabaseConnection | null = null;

  /**
   * 데이터베이스 테이블을 생성합니다.
   * - `tag_catalog`: 태그 카탈로그 테이블
   * - `global_cache`: 전역 캐시 테이블
   */
  private static async createTables(db: DatabaseConnection) {
    await db.exec("PRAGMA journal_mode=WAL;");

    await db.exec(
      `CREATE TABLE IF NOT EXISTS tag_catalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dir STRING NOT NULL,
            branch STRING NOT NULL,
            artifactId STRING NOT NULL,
            path STRING NOT NULL,
            cacheKey STRING NOT NULL,
            lastUpdated INTEGER NOT NULL
        )`,
    );

    await db.exec(
      `CREATE TABLE IF NOT EXISTS global_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cacheKey STRING NOT NULL,
            dir STRING NOT NULL,
            branch STRING NOT NULL,
            artifactId STRING NOT NULL
        )`,
    );
    // Delete duplicate rows from tag_catalog
    await db.exec(`
    DELETE FROM tag_catalog
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM tag_catalog
      GROUP BY dir, branch, artifactId, path, cacheKey
    )
  `);

    // Delete duplicate rows from global_cache
    await db.exec(`
    DELETE FROM global_cache
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM global_cache
      GROUP BY cacheKey, dir, branch, artifactId
    )
  `);

    // Add unique constraints if they don't exist
    await db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_catalog_unique 
     ON tag_catalog(dir, branch, artifactId, path, cacheKey)`,
    );

    await db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_global_cache_unique 
     ON global_cache(cacheKey, dir, branch, artifactId)`,
    );
  }

  private static indexSqlitePath = getIndexSqlitePath();

  /**
   * 데이터베이스 연결을 가져옵니다.
   * - 데이터베이스가 이미 열려 있으면 해당 연결을 반환합니다.
   * - 데이터베이스가 닫혀 있거나 존재하지 않으면 새로 열고 테이블을 생성합니다.
   * @returns 데이터베이스 연결
   */
  static async get() {
    if (SqliteDb.db && fs.existsSync(SqliteDb.indexSqlitePath)) {
      return SqliteDb.db;
    }

    SqliteDb.indexSqlitePath = getIndexSqlitePath();
    SqliteDb.db = await open({
      filename: SqliteDb.indexSqlitePath,
      driver: sqlite3.Database,
    });

    await SqliteDb.db.exec("PRAGMA busy_timeout = 3000;");

    await SqliteDb.createTables(SqliteDb.db);

    return SqliteDb.db;
  }
}

/**
 * 주어진 태그에 대한 저장된 항목을 가져옵니다.
 * @param tag - 인덱싱 태그
 * @returns 저장된 항목의 경로, 캐시 키 및 마지막 업데이트 시간
 */
async function getSavedItemsForTag(
  tag: IndexTag,
): Promise<{ path: string; cacheKey: string; lastUpdated: number }[]> {
  const db = await SqliteDb.get();
  const stmt = await db.prepare(
    `SELECT path, cacheKey, lastUpdated FROM tag_catalog
    WHERE dir = ? AND branch = ? AND artifactId = ?`,
    tag.directory,
    tag.branch,
    tag.artifactId,
  );
  const rows = await stmt.all();
  return rows;
}

enum AddRemoveResultType {
  Add = "add",
  Remove = "remove",
  UpdateNewVersion = "updateNewVersion",
  UpdateOldVersion = "updateOldVersion",
  UpdateLastUpdated = "updateLastUpdated",
  Compute = "compute",
}

// Don't attempt to index anything over 5MB
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * 주어진 태그에 대한 추가 및 제거 작업을 가져옵니다.
 * - 현재 파일 목록과 비교하여 새로 추가된 파일, 업데이트된 파일, 제거된 파일을 식별합니다.
 * @param tag - 인덱싱 태그
 * @param currentFiles - 현재 파일 목록
 * @param readFile - 파일을 읽는 함수
 * @returns 추가, 제거, 업데이트된 파일 목록과 완료 콜백 함수
 */
async function getAddRemoveForTag(
  tag: IndexTag,
  currentFiles: FileStatsMap,
  readFile: (path: string) => Promise<string>,
): Promise<
  [
    PathAndCacheKey[],
    PathAndCacheKey[],
    PathAndCacheKey[],
    MarkCompleteCallback,
  ]
> {
  const newLastUpdatedTimestamp = Date.now();
  const files = { ...currentFiles };

  for (const path in files) {
    if (files[path].size > MAX_FILE_SIZE_BYTES) {
      delete files[path];
    }
  }

  const saved = await getSavedItemsForTag(tag);

  const updateNewVersion: PathAndCacheKey[] = [];
  const updateOldVersion: PathAndCacheKey[] = [];
  const remove: PathAndCacheKey[] = [];
  const updateLastUpdated: PathAndCacheKey[] = [];

  // First, group items by path and find latest timestamp for each
  const pathGroups = new Map<
    string,
    {
      latest: { lastUpdated: number; cacheKey: string };
      allVersions: Array<{ cacheKey: string }>;
    }
  >();

  for (const item of saved) {
    const { lastUpdated, path, cacheKey } = item;

    if (!pathGroups.has(path)) {
      pathGroups.set(path, {
        latest: { lastUpdated, cacheKey },
        allVersions: [{ cacheKey }],
      });
    } else {
      const group = pathGroups.get(path)!;
      group.allVersions.push({ cacheKey });
      if (lastUpdated > group.latest.lastUpdated) {
        group.latest = { lastUpdated, cacheKey };
      }
    }
  }

  // Now process each unique path
  for (const [path, group] of pathGroups) {
    if (files[path] === undefined) {
      // Was indexed, but no longer exists. Remove all versions
      for (const version of group.allVersions) {
        remove.push({ path, cacheKey: version.cacheKey });
      }
    } else {
      // Exists in old and new, so determine whether it was updated
      if (group.latest.lastUpdated < files[path].lastModified) {
        // Change was made after last update
        const newHash = calculateHash(await readFile(path));
        if (group.latest.cacheKey !== newHash) {
          updateNewVersion.push({
            path,
            cacheKey: newHash,
          });
          for (const version of group.allVersions) {
            updateOldVersion.push({ path, cacheKey: version.cacheKey });
          }
        } else {
          // File contents did not change
          updateLastUpdated.push({ path, cacheKey: group.latest.cacheKey });
          for (const version of group.allVersions) {
            if (version.cacheKey !== group.latest.cacheKey) {
              updateOldVersion.push({ path, cacheKey: version.cacheKey });
            }
          }
        }
      } else {
        // Already updated, do nothing
      }

      // Remove path, so that only newly created paths remain
      delete files[path];
    }
  }

  // limit to only 10 concurrent file reads to avoid issues such as
  // "too many file handles". A large number here does not improve
  // throughput due to the nature of disk or network i/o -- huge
  // amounts of readers generally does not improve performance
  const limit = plimit(10);
  const promises = Object.keys(files).map(async (path) => {
    const fileContents = await limit(() => readFile(path));
    return { path, cacheKey: calculateHash(fileContents) };
  });
  const add: PathAndCacheKey[] = await Promise.all(promises);

  // Create the markComplete callback function
  const db = await SqliteDb.get();
  const itemToAction: {
    [key in AddRemoveResultType]: PathAndCacheKey[];
  } = {
    [AddRemoveResultType.Add]: [],
    [AddRemoveResultType.Remove]: [],
    [AddRemoveResultType.UpdateNewVersion]: [],
    [AddRemoveResultType.UpdateOldVersion]: [],
    [AddRemoveResultType.UpdateLastUpdated]: [],
    [AddRemoveResultType.Compute]: [],
  };

  /**
   * 완료 콜백 함수입니다.
   * - 인덱싱 작업이 완료된 후 데이터베이스를 업데이트합니다.
   * @param items - 인덱싱된 항목 목록
   * @param resultType - 인덱싱 결과 유형
   */
  async function markComplete(
    items: PathAndCacheKey[],
    resultType: IndexResultType,
  ) {
    const addRemoveResultType =
      mapIndexResultTypeToAddRemoveResultType(resultType);

    const actionItems = itemToAction[addRemoveResultType];
    if (!actionItems) {
      console.warn(`No action items found for result type: ${resultType}`);
      return;
    }

    for (const item of items) {
      const { path, cacheKey } = item;
      switch (addRemoveResultType) {
        case AddRemoveResultType.Compute:
          await db.run(
            "REPLACE INTO tag_catalog (path, cacheKey, lastUpdated, dir, branch, artifactId) VALUES (?, ?, ?, ?, ?, ?)",
            path,
            cacheKey,
            newLastUpdatedTimestamp,
            tag.directory,
            tag.branch,
            tag.artifactId,
          );
          break;
        case AddRemoveResultType.Add:
          await db.run(
            "REPLACE INTO tag_catalog (path, cacheKey, lastUpdated, dir, branch, artifactId) VALUES (?, ?, ?, ?, ?, ?)",
            path,
            cacheKey,
            newLastUpdatedTimestamp,
            tag.directory,
            tag.branch,
            tag.artifactId,
          );
          break;
        case AddRemoveResultType.Remove:
          await db.run(
            `DELETE FROM tag_catalog WHERE
              cacheKey = ? AND
              path = ? AND
              dir = ? AND
              branch = ? AND
              artifactId = ?
          `,
            cacheKey,
            path,
            tag.directory,
            tag.branch,
            tag.artifactId,
          );
          break;
        case AddRemoveResultType.UpdateLastUpdated:
        case AddRemoveResultType.UpdateNewVersion:
          await db.run(
            `UPDATE tag_catalog SET
                cacheKey = ?,
                lastUpdated = ?
             WHERE
                path = ? AND
                dir = ? AND
                branch = ? AND
                artifactId = ?
            `,
            cacheKey,
            newLastUpdatedTimestamp,
            path,
            tag.directory,
            tag.branch,
            tag.artifactId,
          );
          break;
        case AddRemoveResultType.UpdateOldVersion:
          break;
      }
    }
  }

  for (const item of updateNewVersion) {
    itemToAction[AddRemoveResultType.UpdateNewVersion].push(item);
  }
  for (const item of add) {
    itemToAction[AddRemoveResultType.Add].push(item);
  }
  for (const item of updateOldVersion) {
    itemToAction[AddRemoveResultType.UpdateOldVersion].push(item);
  }
  for (const item of remove) {
    itemToAction[AddRemoveResultType.Remove].push(item);
  }

  return [
    [...add, ...updateNewVersion],
    [...remove, ...updateOldVersion],
    updateLastUpdated,
    markComplete,
  ];
}

/**
 * 전역 캐시에서 주어진 cacheKey와 artifactId에 대한 태그를 가져옵니다.
 * 이 함수는 해당 cacheKey와 artifactId로 전역 캐시(global_cache) 테이블을 조회하여,
 * 존재하는 모든 태그(IndexTag)를 반환합니다. 결과가 없을 수도 있습니다.
 * @param cacheKey - 캐시 키
 * @param artifactId - 아티팩트 ID
 * @returns 태그 목록
 */
async function getTagsFromGlobalCache(
  cacheKey: string,
  artifactId: string,
): Promise<IndexTag[]> {
  const db = await SqliteDb.get();
  const stmt = await db.prepare(
    "SELECT dir, branch, artifactId FROM global_cache WHERE cacheKey = ? AND artifactId = ?",
  );
  const rows = await stmt.all(cacheKey, artifactId);
  return rows;
}

/**
 * 주어진 파일 내용의 SHA-256 해시를 계산합니다.
 * @param fileContents - 파일 내용
 * @returns SHA-256 해시 값
 */
function calculateHash(fileContents: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fileContents);
  return hash.digest("hex");
}

/**
 * 인덱스 결과 유형을 추가/제거 결과 유형으로 매핑합니다.
 * @param resultType - 인덱스 결과 유형
 * @returns 매핑된 추가/제거 결과 유형
 */
function mapIndexResultTypeToAddRemoveResultType(
  resultType: IndexResultType,
): AddRemoveResultType {
  switch (resultType) {
    case "updateLastUpdated":
      return AddRemoveResultType.UpdateLastUpdated;
    case "compute":
      return AddRemoveResultType.Compute;
    case "addTag":
      return AddRemoveResultType.Add;
    case "del":
    case "removeTag":
      return AddRemoveResultType.Remove;
    default:
      throw new Error(`Unexpected result type: ${resultType}`);
  }
}

/**
 * 주어진 태그에 대한 인덱스 갱신 작업을 수행합니다.
 * - 현재 파일 목록과 비교하여 추가, 제거, 업데이트된 파일을 식별하고,
 *   이를 전역 캐시에 반영합니다.
 * @param tag - 인덱싱 태그
 * @param currentFiles - 현재 파일 목록
 * @param readFile - 파일을 읽는 함수
 * @param repoName - 레포지토리 이름 (선택적)
 * @returns 인덱스 갱신 결과, 마지막 업데이트 시간, 완료 콜백 함수
 */
export async function getComputeDeleteAddRemove(
  tag: IndexTag,
  currentFiles: FileStatsMap,
  readFile: (path: string) => Promise<string>,
  repoName: string | undefined,
): Promise<[RefreshIndexResults, PathAndCacheKey[], MarkCompleteCallback]> {
  const [add, remove, lastUpdated, markComplete] = await getAddRemoveForTag(
    tag,
    currentFiles,
    readFile,
  );

  const compute: PathAndCacheKey[] = [];
  const del: PathAndCacheKey[] = [];
  const addTag: PathAndCacheKey[] = [];
  const removeTag: PathAndCacheKey[] = [];

  for (const { path, cacheKey } of add) {
    const existingTags = await getTagsFromGlobalCache(cacheKey, tag.artifactId);
    if (existingTags.length > 0) {
      addTag.push({ path, cacheKey });
    } else {
      compute.push({ path, cacheKey });
    }
  }

  for (const { path, cacheKey } of remove) {
    const existingTags = await getTagsFromGlobalCache(cacheKey, tag.artifactId);
    if (existingTags.length > 1) {
      removeTag.push({ path, cacheKey });
    } else {
      if (existingTags.length === 0) {
        // console.warn("Existing tags should not be empty when trying to remove");
      }

      del.push({ path, cacheKey });
    }
  }

  const results = {
    compute,
    del,
    addTag,
    removeTag,
  };

  const globalCacheIndex = await GlobalCacheCodeBaseIndex.create();

  return [
    results,
    lastUpdated,
    async (items, resultType) => {
      // Update tag catalog
      await markComplete(items, resultType);

      // Update the global cache
      const results: any = {
        compute: [],
        del: [],
        addTag: [],
        removeTag: [],
      };
      results[resultType] = items;
      for await (const _ of globalCacheIndex.update(
        tag,
        results,
        async () => {},
        repoName,
      )) {
      }
    },
  ];
}

/**
 * 전역 캐시 코드베이스 인덱스 클래스입니다.
 * - 인덱스 업데이트 및 관리를 담당합니다.
 */
export class GlobalCacheCodeBaseIndex implements CodebaseIndex {
  relativeExpectedTime: number = 1;

  constructor(private db: DatabaseConnection) {}

  artifactId = "globalCache";

  static async create(): Promise<GlobalCacheCodeBaseIndex> {
    return new GlobalCacheCodeBaseIndex(await SqliteDb.get());
  }

  async *update(
    tag: IndexTag,
    results: RefreshIndexResults,
    _: MarkCompleteCallback,
    repoName: string | undefined,
  ): AsyncGenerator<IndexingProgressUpdate> {
    const add = [...results.compute, ...results.addTag];
    const remove = [...results.del, ...results.removeTag];
    await Promise.all([
      ...remove.map(({ cacheKey }) => {
        return this.deleteOrRemoveTag(cacheKey, tag);
      }),
      ...add.map(({ cacheKey }) => {
        return this.computeOrAddTag(cacheKey, tag);
      }),
    ]);
    yield { progress: 1, desc: "Done updating global cache", status: "done" };
  }

  private async computeOrAddTag(
    cacheKey: string,
    tag: IndexTag,
  ): Promise<void> {
    await this.db.run(
      "REPLACE INTO global_cache (cacheKey, dir, branch, artifactId) VALUES (?, ?, ?, ?)",
      cacheKey,
      tag.directory,
      tag.branch,
      tag.artifactId,
    );
  }
  private async deleteOrRemoveTag(
    cacheKey: string,
    tag: IndexTag,
  ): Promise<void> {
    await this.db.run(
      "DELETE FROM global_cache WHERE cacheKey = ? AND dir = ? AND branch = ? AND artifactId = ?",
      cacheKey,
      tag.directory,
      tag.branch,
      tag.artifactId,
    );
  }
}

const SQLITE_MAX_LIKE_PATTERN_LENGTH = 50000;

/**
 * 문자열을 최대 N 바이트로 잘라냅니다.
 * @param input - 입력 문자열
 * @param maxBytes - 최대 바이트 수
 * @returns 잘라낸 문자열
 */
export function truncateToLastNBytes(input: string, maxBytes: number): string {
  let bytes = 0;
  let startIndex = 0;

  for (let i = input.length - 1; i >= 0; i--) {
    bytes += new TextEncoder().encode(input[i]).length;
    if (bytes > maxBytes) {
      startIndex = i + 1;
      break;
    }
  }

  return input.substring(startIndex, input.length);
}

/**
 * SQLite LIKE 패턴을 안전하게 잘라냅니다.
 * @param input - 입력 문자열
 * @param safety - 안전 여유 공간 (기본값: 100)
 * @returns 잘라낸 문자열
 */
export function truncateSqliteLikePattern(input: string, safety: number = 100) {
  return truncateToLastNBytes(input, SQLITE_MAX_LIKE_PATTERN_LENGTH - safety);
}
