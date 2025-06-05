import { BranchAndDir, Chunk, IndexTag, IndexingProgressUpdate } from "../";
import { RETRIEVAL_PARAMS } from "../util/parameters";
import { getUriPathBasename } from "../util/uri";

import { ChunkCodebaseIndex } from "./chunk/ChunkCodebaseIndex";
import { DatabaseConnection, SqliteDb } from "./refreshIndex";
import {
  IndexResultType,
  MarkCompleteCallback,
  RefreshIndexResults,
  type CodebaseIndex,
} from "./types";
import { tagToString } from "./utils";

export interface RetrieveConfig {
  tags: BranchAndDir[];
  text: string;
  n: number;
  directory?: string;
  filterPaths?: string[];
  bm25Threshold?: number;
}

/**
 * FullTextSearchCodebaseIndex는 SQLite FTS5를 사용하여 코드베이스의 전체 텍스트 검색을 지원합니다.
 * 이 인덱스는 청크를 인덱싱하고, 태그를 추가/제거하며, 검색 쿼리를 처리합니다.
 */
export class FullTextSearchCodebaseIndex implements CodebaseIndex {
  relativeExpectedTime: number = 0.2;
  static artifactId = "sqliteFts";
  artifactId: string = FullTextSearchCodebaseIndex.artifactId;
  pathWeightMultiplier = 10.0;

  /**
   * 데이터베이스 테이블을 생성합니다.
   * @param db - 데이터베이스 연결 객체
   */
  private async _createTables(db: DatabaseConnection) {
    await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        path,
        content,
        tokenize = 'trigram'
    )`);

    await db.exec(`CREATE TABLE IF NOT EXISTS fts_metadata (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        cacheKey TEXT NOT NULL,
        chunkId INTEGER NOT NULL,
        FOREIGN KEY (chunkId) REFERENCES chunks (id),
        FOREIGN KEY (id) REFERENCES fts (rowid)
    )`);
  }

  /**
   * 인덱스를 업데이트합니다.
   * @param tag - 인덱싱 태그
   * @param results - 인덱싱 결과
   * @param markComplete - 완료 콜백
   * @param repoName - 레포지토리 이름 (선택적)
   */
  async *update(
    tag: IndexTag,
    results: RefreshIndexResults,
    markComplete: MarkCompleteCallback,
    repoName: string | undefined,
  ): AsyncGenerator<IndexingProgressUpdate, any, unknown> {
    const db = await SqliteDb.get();
    await this._createTables(db);

    for (let i = 0; i < results.compute.length; i++) {
      const item = results.compute[i];

      // Insert chunks
      const chunks = await db.all(
        "SELECT * FROM chunks WHERE path = ? AND cacheKey = ?",
        [item.path, item.cacheKey],
      );

      for (const chunk of chunks) {
        const { lastID } = await db.run(
          "INSERT INTO fts (path, content) VALUES (?, ?)",
          [item.path, chunk.content],
        );
        await db.run(
          `INSERT INTO fts_metadata (id, path, cacheKey, chunkId) 
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           cacheKey = excluded.cacheKey,
           chunkId = excluded.chunkId`,
          [lastID, item.path, item.cacheKey, chunk.id],
        );
      }

      yield {
        progress: i / results.compute.length,
        desc: `Indexing ${getUriPathBasename(item.path)}`,
        status: "indexing",
      };
      await markComplete([item], IndexResultType.Compute);
    }

    // Add tag
    for (const item of results.addTag) {
      await markComplete([item], IndexResultType.AddTag);
    }

    // Remove tag
    for (const item of results.removeTag) {
      await markComplete([item], IndexResultType.RemoveTag);
    }

    // Delete
    for (const item of results.del) {
      await db.run(
        `
        DELETE FROM fts WHERE rowid IN (
          SELECT id FROM fts_metadata WHERE path = ? AND cacheKey = ?
        )
      `,
        [item.path, item.cacheKey],
      );
      await db.run("DELETE FROM fts_metadata WHERE path = ? AND cacheKey = ?", [
        item.path,
        item.cacheKey,
      ]);
      await markComplete([item], IndexResultType.Delete);
    }
  }

  /**
   * 청크 조회
   * @returns 청크 데이터
   */
  async retrieve(config: RetrieveConfig): Promise<Chunk[]> {
    const db = await SqliteDb.get();

    const query = this.buildRetrieveQuery(config);
    const parameters = this.getRetrieveQueryParameters(config);

    let results = await db.all(query, parameters);

    results = results.filter(
      (result) =>
        result.rank <= (config.bm25Threshold ?? RETRIEVAL_PARAMS.bm25Threshold),
    );

    const chunks = await db.all(
      `SELECT * FROM chunks WHERE id IN (${results.map(() => "?").join(",")})`,
      results.map((result) => result.chunkId),
    );

    return chunks.map((chunk) => ({
      filepath: chunk.path,
      index: chunk.index,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      digest: chunk.cacheKey,
    }));
  }

  /**
   * 태그 필터를 빌드합니다.
   * @param tags - 필터링할 태그 목록
   * @returns SQL WHERE 절의 일부로 사용할 태그 필터 문자열
   */
  private buildTagFilter(tags: BranchAndDir[]): string {
    const tagStrings = this.convertTags(tags);

    return `AND chunk_tags.tag IN (${tagStrings.map(() => "?").join(",")})`;
  }

  /**
   * 경로 필터를 빌드합니다.
   * @param filterPaths - 필터링할 경로 목록
   * @returns SQL WHERE 절의 일부로 사용할 경로 필터 문자열
   */
  private buildPathFilter(filterPaths: string[] | undefined): string {
    if (!filterPaths || filterPaths.length === 0) {
      return "";
    }
    return `AND fts_metadata.path IN (${filterPaths.map(() => "?").join(",")})`;
  }

  /**
   * 검색 쿼리를 빌드합니다.
   * @param config - 검색 구성
   * @returns SQL 쿼리 문자열
   */
  private buildRetrieveQuery(config: RetrieveConfig): string {
    return `
      SELECT fts_metadata.chunkId, fts_metadata.path, fts.content, rank
      FROM fts
      JOIN fts_metadata ON fts.rowid = fts_metadata.id
      JOIN chunk_tags ON fts_metadata.chunkId = chunk_tags.chunkId
      WHERE fts MATCH ?
      ${this.buildTagFilter(config.tags)}
      ${this.buildPathFilter(config.filterPaths)}
      ORDER BY bm25(fts, ${this.pathWeightMultiplier})
      LIMIT ?
    `;
  }

  /**
   * 검색 쿼리 매개변수를 가져옵니다.
   * @param config - 검색 구성
   * @returns 쿼리 매개변수 배열
   */
  private getRetrieveQueryParameters(config: RetrieveConfig) {
    const { text, tags, filterPaths, n } = config;
    const tagStrings = this.convertTags(tags);

    return [
      text.replace(/\?/g, ""),
      ...tagStrings,
      ...(filterPaths || []),
      Math.ceil(n),
    ];
  }

  /**
   * 태그를 문자열 배열로 변환합니다.
   * @param tags - 변환할 태그 목록
   * @returns 태그 문자열 배열
   */
  private convertTags(tags: BranchAndDir[]): string[] {
    // Notice that the "chunks" artifactId is used because of linking between tables
    return tags.map((tag) =>
      tagToString({ ...tag, artifactId: ChunkCodebaseIndex.artifactId }),
    );
  }
}
