import { fetchwithRequestOptions } from "@continuedev/fetch";
import * as URI from "uri-js";
import { v4 as uuidv4 } from "uuid";

import { CompletionProvider } from "./autocomplete/CompletionProvider";
import { ConfigHandler } from "./config/ConfigHandler";
import { SYSTEM_PROMPT_DOT_FILE } from "./config/getWorkspaceContinueRuleDotFiles";
import { addModel, deleteModel } from "./config/util";
import CodebaseContextProvider from "./context/providers/CodebaseContextProvider";
import CurrentFileContextProvider from "./context/providers/CurrentFileContextProvider";
import { recentlyEditedFilesCache } from "./context/retrieval/recentlyEditedFilesCache";
import { ContinueServerClient } from "./continueServer/stubs/client";
import { getAuthUrlForTokenPage } from "./control-plane/auth/index";
import { getControlPlaneEnv } from "./control-plane/env";
import { DevDataSqliteDb } from "./data/devdataSqlite";
import { DataLogger } from "./data/log";
import { CodebaseIndexer, PauseToken } from "./indexing/CodebaseIndexer";
import DocsService from "./indexing/docs/DocsService";
import { countTokens } from "./llm/countTokens";
import Ollama from "./llm/llms/Ollama";
import { createNewPromptFileV2 } from "./promptFiles/v2/createNewPromptFile";
import { callTool } from "./tools/callTool";
import { ChatDescriber } from "./util/chatDescriber";
import { clipboardCache } from "./util/clipboardCache";
import { GlobalContext } from "./util/GlobalContext";
import historyManager from "./util/history";
import { editConfigFile, migrateV1DevDataFiles } from "./util/paths";
import { Telemetry } from "./util/posthog";
import {
  isProcessBackgrounded,
  markProcessAsBackgrounded,
} from "./util/processTerminalBackgroundStates";
import { getSymbolsForManyFiles } from "./util/treeSitter";
import { TTS } from "./util/tts";

import {
  ContextItemWithId,
  IdeSettings,
  ModelDescription,
  RangeInFile,
  type ContextItem,
  type ContextItemId,
  type IDE,
  type IndexingProgressUpdate,
} from ".";

import { ConfigYaml } from "@continuedev/config-yaml";
import { isLocalAssistantFile } from "./config/loadLocalAssistants";
import {
  setupBestConfig,
  setupLocalConfig,
  setupQuickstartConfig,
} from "./config/onboarding";
import { createNewWorkspaceBlockFile } from "./config/workspace/workspaceBlocks";
import { MCPManagerSingleton } from "./context/mcp/MCPManagerSingleton";
import { streamDiffLines } from "./edit/streamDiffLines";
import { shouldIgnore } from "./indexing/shouldIgnore";
import { walkDirCache } from "./indexing/walkDir";
import { LLMError } from "./llm";
import { LLMLogger } from "./llm/logger";
import { llmStreamChat } from "./llm/streamChat";
import type { FromCoreProtocol, ToCoreProtocol } from "./protocol";
import type { IMessenger, Message } from "./protocol/messenger";
import { StreamAbortManager } from "./util/abortManager";

/**
 * Core 클래스는 Continue 확장 프로그램의 백엔드 로직을 중앙에서 조율하는 역할을 합니다.
 * 이 클래스는 설정 관리, 코드베이스 인덱싱, LLM 연산, 컨텍스트 제공자, 그리고 메신저 인터페이스를 통한
 * IDE와의 통신을 담당합니다.
 *
 * 주요 역할:
 * - ConfigHandler를 통한 설정 및 프로필 관리
 * - 코드베이스 인덱싱 및 진행 상황 업데이트 관리
 * - LLM 완성 및 채팅 기능 제공
 * - IDE 통합, 파일 시스템 이벤트, 컨텍스트/문서 인덱싱, 인증, 도구 호출, 텔레메트리 등
 *   다양한 메시지 타입 등록 및 처리
 * - 컨텍스트 제공자 및 컨텍스트 아이템 조회 관리
 * - 온보딩 플로우 및 동적 설정 업데이트 처리
 * - 메시지 취소 및 인덱싱 작업을 위한 abort 컨트롤러 관리
 *
 * @remarks
 * - Core 클래스는 확장 프로그램 세션마다 한 번만 인스턴스화되어야 합니다.
 * - IDE 프론트엔드와의 통신을 위해 IMessenger 인터페이스에 강하게 결합되어 있습니다.
 * - 많은 작업이 비동기적으로 이루어지며, 초기화와 이벤트 처리를 위해 Promise를 사용합니다.
 * - 오류 처리와 텔레메트리는 강력한 진단 및 보고를 위해 중앙 집중화되어 있습니다.
 *
 * @example
 * ```typescript
 * const core = new Core(messenger, ide);
 * ```
 */
export class Core {
  configHandler: ConfigHandler;
  codebaseIndexerPromise: Promise<CodebaseIndexer>;
  completionProvider: CompletionProvider;
  continueServerClientPromise: Promise<ContinueServerClient>;
  codebaseIndexingState: IndexingProgressUpdate;
  private docsService: DocsService;
  private globalContext = new GlobalContext();
  llmLogger = new LLMLogger();

  /**
   * IDE의 전역 컨텍스트를 관리합니다.
   * IDE 설정, 프로필, 조직 등을 포함합니다.
   */
  private readonly indexingPauseToken = new PauseToken(
    this.globalContext.get("indexingPaused") === true,
  );

  /**
   * 메시지 ID로 AbortController를 관리하는 Map입니다.
   * 메시지 전송 중에 취소할 수 있도록 합니다.
   */
  private messageAbortControllers = new Map<string, AbortController>();

  /**
   * 메시지 ID에 대한 AbortController를 추가하고, 해당 컨트롤러가 중단되면 삭제합니다.
   *
   * @param id - AbortController를 추가할 메시지 ID
   * @returns 새로 생성된 AbortController 인스턴스
   */
  private addMessageAbortController(id: string): AbortController {
    const controller = new AbortController();
    this.messageAbortControllers.set(id, controller);
    controller.signal.addEventListener("abort", () => {
      this.messageAbortControllers.delete(id);
    });
    return controller;
  }

  /**
   * 메시지 ID로 AbortController를 추가합니다.
   * @param messageId 메시지 ID
   * @returns AbortController
   */
  private abortById(messageId: string) {
    this.messageAbortControllers.get(messageId)?.abort();
  }

  /**
   * 코어 프로토콜 메시지를 호출하고 응답을 반환합니다.
   *
   * @param messageType - 호출할 메시지 타입
   * @param data - 메시지에 포함될 데이터
   * @returns 메시지 응답
   */
  invoke<T extends keyof ToCoreProtocol>(
    messageType: T,
    data: ToCoreProtocol[T][0],
  ): ToCoreProtocol[T][1] {
    return this.messenger.invoke(messageType, data);
  }

  /**
   * 메시지를 전송하고 응답을 기다립니다.
   * @param messageType 메시지 유형
   * @param data 메시지 데이터
   * @param messageId 선택적 메시지 ID
   * @returns 메시지 ID
   */
  send<T extends keyof FromCoreProtocol>(
    messageType: T,
    data: FromCoreProtocol[T][0],
    messageId?: string,
  ): string {
    return this.messenger.send(messageType, data, messageId);
  }

  // TODO: 실제로는 IDE 타입이 필요하지 않아야 합니다.
  // 이 작업은 메신저를 통해서도 발생할 수 있기 때문입니다
  // (VS Code가 아닌 다른 IDE의 경우 이미 메신저를 통해 처리되고 있습니다).
  constructor(
    private readonly messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>,
    private readonly ide: IDE,
  ) {
    // Ensure .continue directory is created
    migrateV1DevDataFiles();

    this.codebaseIndexingState = {
      status: "loading",
      desc: "loading",
      progress: 0,
    };

    const ideInfoPromise = messenger.request("getIdeInfo", undefined);
    const ideSettingsPromise = messenger.request("getIdeSettings", undefined);
    const sessionInfoPromise = messenger.request("getControlPlaneSessionInfo", {
      silent: true,
      useOnboarding: false,
    });

    this.configHandler = new ConfigHandler(
      this.ide,
      ideSettingsPromise,
      this.llmLogger,
      sessionInfoPromise,
    );

    this.docsService = DocsService.createSingleton(
      this.configHandler,
      this.ide,
      this.messenger,
    );

    /**
     * IDE의 전역 컨텍스트를 초기화합니다.
     */
    MCPManagerSingleton.getInstance().onConnectionsRefreshed = async () => {
      await this.configHandler.reloadConfig();
    };

    /**
     * IDE 설정을 로드하고, 초기화합니다.
     */
    this.configHandler.onConfigUpdate(async (result) => {
      const serializedResult = await this.configHandler.getSerializedConfig();
      this.messenger.send("configUpdate", {
        result: serializedResult,
        profileId:
          this.configHandler.currentProfile?.profileDescription.id || null,
        organizations: this.configHandler.getSerializedOrgs(),
        selectedOrgId: this.configHandler.currentOrg.id,
      });

      // update additional submenu context providers registered via VSCode API
      const additionalProviders =
        this.configHandler.getAdditionalSubmenuContextProviders();
      if (additionalProviders.length > 0) {
        this.messenger.send("refreshSubmenuItems", {
          providers: additionalProviders,
        });
      }
    });

    // Dev Data Logger
    const dataLogger = DataLogger.getInstance();
    dataLogger.core = this;
    dataLogger.ideInfoPromise = ideInfoPromise;
    dataLogger.ideSettingsPromise = ideSettingsPromise;

    // Codebase Indexer and ContinueServerClient depend on IdeSettings
    let codebaseIndexerResolve: (_: any) => void | undefined;
    this.codebaseIndexerPromise = new Promise(
      async (resolve) => (codebaseIndexerResolve = resolve),
    );

    let continueServerClientResolve: (_: any) => void | undefined;
    this.continueServerClientPromise = new Promise(
      (resolve) => (continueServerClientResolve = resolve),
    );

    /**
     * IDE 설정을 로드하고, ContinueServerClient와 CodebaseIndexer를 초기화합니다.
     */
    void ideSettingsPromise.then((ideSettings) => {
      const continueServerClient = new ContinueServerClient(
        ideSettings.remoteConfigServerUrl,
        ideSettings.userToken,
      );
      continueServerClientResolve(continueServerClient);

      codebaseIndexerResolve(
        new CodebaseIndexer(
          this.configHandler,
          this.ide,
          this.indexingPauseToken,
          continueServerClient,
        ),
      );

      // Index on initialization
      void this.ide.getWorkspaceDirs().then(async (dirs) => {
        // Respect pauseCodebaseIndexOnStart user settings
        if (ideSettings.pauseCodebaseIndexOnStart) {
          this.indexingPauseToken.paused = true;
          void this.messenger.request("indexProgress", {
            progress: 0,
            desc: "Initial Indexing Skipped",
            status: "paused",
          });
          return;
        }

        void this.refreshCodebaseIndex(dirs);
      });
    });

    /**
     * @returns 선택된 LLM 모델을 반환합니다.
     */
    const getLlm = async () => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        return undefined;
      }
      return config.selectedModelByRole.autocomplete ?? undefined;
    };

    this.completionProvider = new CompletionProvider(
      this.configHandler,
      ide,
      getLlm,
      (e) => {},
      (..._) => Promise.resolve([]),
    );

    this.registerMessageHandlers(ideSettingsPromise);
  }

  /* eslint-disable max-lines-per-function */
  /**
   * 코어 메신저 인터페이스의 모든 메시지 핸들러를 등록합니다.
   *
   * 이 메서드는 다양한 메시지 타입을 해당 핸들러 함수에 바인딩하여,
   * 코어 로직과 IDE, 설정, LLM, 컨텍스트 제공자, 파일 시스템, 인덱싱 및 기타 서비스 간의
   * 통신을 가능하게 합니다. 각 지원되는 메시지 타입에 대해 오류 처리, 명령 라우팅,
   * 비동기 작업을 설정합니다.
   *
   * @param ideSettingsPromise - 일부 설정 및 인증 흐름에 사용되는 IDE 설정을 반환하는 프로미스입니다.
   *
   * @remarks
   * - 핸들러는 히스토리 관리, 설정 업데이트, LLM 연산, 컨텍스트/문서 인덱싱,
   *   파일 시스템 이벤트, 인증, 도구 호출, 프로세스 상태 등 다양한 영역을 다룹니다.
   * - 일부 핸들러는 비동기이며 결과를 반환하거나 부수 효과를 발생시킬 수 있습니다.
   * - 메신저 오류에 대한 오류 처리는 중앙 집중화되어 있으며, 특정 메시지 타입에 대해 중복 오류 메시지를 방지하는 특별한 로직이 있습니다.
   * - 모든 메시지 타입이 적절히 처리되도록 초기화 시 이 메서드를 호출해야 합니다.
   */
  private registerMessageHandlers(ideSettingsPromise: Promise<IdeSettings>) {
    const on = this.messenger.on.bind(this.messenger);

    // Note, VsCode's in-process messenger doesn't do anything with this
    // It will only show for jetbrains
    this.messenger.onError((message, err) => {
      void Telemetry.capture("core_messenger_error", {
        message: err.message,
        stack: err.stack,
      });

      // just to prevent duplicate error messages in jetbrains (same logic in webview protocol)
      if (
        ["llm/streamChat", "chatDescriber/describe"].includes(
          message.messageType,
        )
      ) {
        return;
      } else {
        void this.ide.showToast("error", err.message);
      }
    });

    // Abort 요청 처리: 메시지 ID로 AbortController를 취소합니다.
    on("abort", (msg) => {
      this.abortById(msg.data ?? msg.messageId);
    });

    // Ping 요청 처리: ping 메시지에 대해 pong을 반환합니다.
    on("ping", (msg) => {
      if (msg.data !== "ping") {
        throw new Error("ping message incorrect");
      }
      return "pong";
    });

    // 히스토리 관련 메시지 핸들러
    // 히스토리 목록 조회
    on("history/list", (msg) => {
      return historyManager.list(msg.data);
    });
    // 히스토리 삭제
    on("history/delete", (msg) => {
      historyManager.delete(msg.data.id);
    });
    // 히스토리 로드
    on("history/load", (msg) => {
      return historyManager.load(msg.data.id);
    });
    // 히스토리 저장
    on("history/save", (msg) => {
      historyManager.save(msg.data);
    });
    // 히스토리 전체 삭제
    on("history/clear", (msg) => {
      historyManager.clearAll();
    });

    // 개발 데이터 로깅
    on("devdata/log", async (msg) => {
      void DataLogger.getInstance().logDevData(msg.data);
    });

    // Config 관련 메시지 핸들러
    // 모델 추가
    on("config/addModel", (msg) => {
      const model = msg.data.model;
      addModel(model, msg.data.role);
      void this.configHandler.reloadConfig();
    });
    // 모델 삭제
    on("config/deleteModel", (msg) => {
      deleteModel(msg.data.title);
      void this.configHandler.reloadConfig();
    });
    // 새 프롬프트 파일 생성
    on("config/newPromptFile", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      await createNewPromptFileV2(this.ide, config?.experimental?.promptPath);
      await this.configHandler.reloadConfig();
    });
    // 로컬 워크스페이스 블록 추가
    on("config/addLocalWorkspaceBlock", async (msg) => {
      await createNewWorkspaceBlockFile(this.ide, msg.data.blockType);
      await this.configHandler.reloadConfig();
    });
    // 프로필 열기
    on("config/openProfile", async (msg) => {
      await this.configHandler.openConfigProfile(msg.data.profileId);
    });
    // Config 리로드
    on("config/reload", async (msg) => {
      void this.configHandler.reloadConfig();
      return await this.configHandler.getSerializedConfig();
    });
    // IDE 설정 업데이트
    on("config/ideSettingsUpdate", async (msg) => {
      await this.configHandler.updateIdeSettings(msg.data);
    });
    // 프로필 목록 새로고침
    on("config/refreshProfiles", async (msg) => {
      const { selectOrgId, selectProfileId } = msg.data ?? {};
      await this.configHandler.refreshAll();
      if (selectOrgId) {
        await this.configHandler.setSelectedOrgId(selectOrgId, selectProfileId);
      } else if (selectProfileId) {
        await this.configHandler.setSelectedProfileId(selectProfileId);
      }
    });
    // 공유 Config 업데이트
    on("config/updateSharedConfig", async (msg) => {
      const newSharedConfig = this.globalContext.updateSharedConfig(msg.data);
      await this.configHandler.reloadConfig();
      return newSharedConfig;
    });
    // 선택된 모델 업데이트
    on("config/updateSelectedModel", async (msg) => {
      const newSelectedModels = this.globalContext.updateSelectedModel(
        msg.data.profileId,
        msg.data.role,
        msg.data.title,
      );
      await this.configHandler.reloadConfig();
      return newSelectedModels;
    });

    // 컨트롤 플레인 URL 열기
    on("controlPlane/openUrl", async (msg) => {
      const env = await getControlPlaneEnv(this.ide.getIdeSettings());
      let url = `${env.APP_URL}${msg.data.path}`;
      if (msg.data.orgSlug) {
        url += `?org=${msg.data.orgSlug}`;
      }
      await this.messenger.request("openUrl", url);
    });

    // MCP 서버 리로드
    on("mcp/reloadServer", async (msg) => {
      await MCPManagerSingleton.getInstance().refreshConnection(msg.data.id);
    });

    // Context provider 관련 메시지 핸들러
    // 문서 추가 및 인덱싱
    on("context/addDocs", async (msg) => {
      void this.docsService.indexAndAdd(msg.data);
    });
    // 문서 제거
    on("context/removeDocs", async (msg) => {
      await this.docsService.delete(msg.data.startUrl);
    });
    // 문서 인덱싱
    on("context/indexDocs", async (msg) => {
      await this.docsService.syncDocsWithPrompt(msg.data.reIndex);
    });
    // 서브메뉴 아이템 로드
    on("context/loadSubmenuItems", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        return [];
      }

      try {
        const items = await config.contextProviders
          ?.find((provider) => provider.description.title === msg.data.title)
          ?.loadSubmenuItems({
            config,
            ide: this.ide,
            fetch: (url, init) =>
              fetchwithRequestOptions(url, init, config.requestOptions),
          });
        return items || [];
      } catch (e) {
        console.error(e);
        return [];
      }
    });
    // 컨텍스트 아이템 조회
    on("context/getContextItems", this.getContextItems.bind(this));
    // 파일 심볼 조회
    on("context/getSymbolsForFiles", async (msg) => {
      const { uris } = msg.data;
      return await getSymbolsForManyFiles(uris, this.ide);
    });
    // 직렬화된 프로필 정보 조회
    on("config/getSerializedProfileInfo", async (msg) => {
      return {
        result: await this.configHandler.getSerializedConfig(),
        profileId:
          this.configHandler.currentProfile?.profileDescription.id ?? null,
        organizations: this.configHandler.getSerializedOrgs(),
        selectedOrgId: this.configHandler.currentOrg.id,
      };
    });

    // 클립보드 캐시 추가
    on("clipboardCache/add", (msg) => {
      const added = clipboardCache.add(uuidv4(), msg.data.content);
      if (added) {
        this.messenger.send("refreshSubmenuItems", {
          providers: ["clipboard"],
        });
      }
    });

    // LLM 관련 메시지 핸들러
    // 채팅 스트림
    on("llm/streamChat", (msg) => {
      const abortController = this.addMessageAbortController(msg.messageId);
      return llmStreamChat(
        this.configHandler,
        abortController,
        msg,
        this.ide,
        this.messenger,
      );
    });
    // LLM 완성
    on("llm/complete", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      const model = config?.selectedModelByRole.chat;
      if (!model) {
        throw new Error("No chat model selected");
      }
      const abortController = this.addMessageAbortController(msg.messageId);

      const completion = await model.complete(
        msg.data.prompt,
        abortController.signal,
        msg.data.completionOptions,
      );
      return completion;
    });
    // 모델 목록 조회
    on("llm/listModels", this.handleListModels.bind(this));

    // 유틸리티에 메신저 제공
    TTS.messenger = this.messenger;
    ChatDescriber.messenger = this.messenger;

    // TTS 종료
    on("tts/kill", async () => {
      void TTS.kill();
    });
    // 채팅 설명 요청
    on("chatDescriber/describe", async (msg) => {
      const currentModel = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!currentModel) {
        throw new Error("No chat model selected");
      }

      return await ChatDescriber.describe(currentModel, {}, msg.data.text);
    });

    // 자동완성 관련 메시지 핸들러
    // 인라인 자동완성 요청
    on("autocomplete/complete", async (msg) => {
      const outcome =
        await this.completionProvider.provideInlineCompletionItems(
          msg.data,
          undefined,
        );
      return outcome ? [outcome.completion] : [];
    });
    // 자동완성 수락
    on("autocomplete/accept", async (msg) => {
      this.completionProvider.accept(msg.data.completionId);
    });
    // 자동완성 취소
    on("autocomplete/cancel", async (msg) => {
      this.completionProvider.cancel();
    });

    // diff 라인 스트림 처리
    on("streamDiffLines", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        throw new Error("Failed to load config");
      }

      const { data } = msg;

      // Title can be an edit, chat, or apply model
      // Fall back to chat
      const llm =
        config.modelsByRole.edit.find((m) => m.title === data.modelTitle) ??
        config.modelsByRole.apply.find((m) => m.title === data.modelTitle) ??
        config.modelsByRole.chat.find((m) => m.title === data.modelTitle) ??
        config.selectedModelByRole.chat;

      if (!llm) {
        throw new Error("No model selected");
      }

      return streamDiffLines({
        highlighted: data.highlighted,
        prefix: data.prefix,
        suffix: data.suffix,
        llm,
        // rules included for edit, NOT apply
        rulesToInclude: data.includeRulesInSystemMessage
          ? config.rules
          : undefined,
        input: data.input,
        language: data.language,
        onlyOneInsertion: false,
        overridePrompt: undefined,
        abortControllerId: data.fileUri ?? "current-file-stream", // not super important since currently cancelling apply will cancel all streams it's one file at a time
      });
    });

    // apply 취소
    on("cancelApply", async (msg) => {
      const abortManager = StreamAbortManager.getInstance();
      abortManager.clear();
    });

    // 온보딩 완료 처리
    on("completeOnboarding", this.handleCompleteOnboarding.bind(this));
    // 자동완성 모델 추가
    on("addAutocompleteModel", this.handleAddAutocompleteModel.bind(this));

    // 통계 관련 메시지 핸들러
    // 일별 토큰 수 조회
    on("stats/getTokensPerDay", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerDay();
      return rows;
    });
    // 모델별 토큰 수 조회
    on("stats/getTokensPerModel", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerModel();
      return rows;
    });

    // 인덱싱 관련 메시지 핸들러
    // 강제 리인덱싱
    on("index/forceReIndex", async ({ data }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config || config.disableIndexing) {
        return; // TODO silent in case of commands?
      }
      walkDirCache.invalidate();
      if (data?.shouldClearIndexes) {
        const codebaseIndexer = await this.codebaseIndexerPromise;
        await codebaseIndexer.clearIndexes();
      }
      const dirs = data?.dirs ?? (await this.ide.getWorkspaceDirs());
      await this.refreshCodebaseIndex(dirs);
    });
    // 인덱싱 일시정지 상태를 설정합니다. (코드베이스 인덱싱의 일시정지/재개)
    on("index/setPaused", (msg) => {
      this.globalContext.update("indexingPaused", msg.data);
      this.indexingPauseToken.paused = msg.data;
    });
    // 인덱싱 진행 표시줄이 초기화될 때 호출됩니다. 이전 상태가 있으면 해당 상태로 표시를 갱신합니다.
    on("index/indexingProgressBarInitialized", async (msg) => {
      // Triggered when progress bar is initialized.
      // If a non-default state has been stored, update the indexing display to that state
      if (this.codebaseIndexingState.status !== "loading") {
        void this.messenger.request(
          "indexProgress",
          this.codebaseIndexingState,
        );
      }
    });

    // 파일 변경 이벤트를 처리합니다. (파일이 변경되었을 때 인덱싱 및 서브메뉴 갱신)
    on("files/changed", this.handleFilesChanged.bind(this));
    const refreshIfNotIgnored = async (uris: string[]) => {
      const toRefresh: string[] = [];
      for (const uri of uris) {
        const ignore = await shouldIgnore(uri, this.ide);
        if (!ignore) {
          toRefresh.push(uri);
        }
      }
      if (toRefresh.length > 0) {
        this.messenger.send("refreshSubmenuItems", {
          providers: ["file"],
        });
        const { config } = await this.configHandler.loadConfig();
        if (config && !config.disableIndexing) {
          await this.refreshCodebaseIndexFiles(toRefresh);
        }
      }
    };

    // 파일이 생성되었을 때 인덱싱 및 로컬 어시스턴트 파일 생성 시 전체 어시스턴트 목록을 갱신합니다.
    on("files/created", async ({ data }) => {
      if (data?.uris?.length) {
        walkDirCache.invalidate();
        void refreshIfNotIgnored(data.uris);

        // If it's a local assistant being created, we want to reload all assistants so it shows up in the list
        let localAssistantCreated = false;
        for (const uri of data.uris) {
          if (isLocalAssistantFile(uri)) {
            localAssistantCreated = true;
          }
        }
        if (localAssistantCreated) {
          await this.configHandler.refreshAll();
        }
      }
    });

    // 파일이 삭제되었을 때 인덱싱 및 서브메뉴 갱신을 처리합니다.
    on("files/deleted", async ({ data }) => {
      if (data?.uris?.length) {
        walkDirCache.invalidate();
        void refreshIfNotIgnored(data.uris);
      }
    });

    // 파일이 닫혔을 때 해당 파일의 닫힘 이벤트를 전달합니다.
    on("files/closed", async ({ data }) => {
      if (data.uris) {
        this.messenger.send("didCloseFiles", {
          uris: data.uris,
        });
      }
    });

    // 파일이 열렸을 때의 이벤트 핸들러(현재는 동작 없음)
    on("files/opened", async () => {});

    // 문서(Docs) 인덱싱: 특정 문서의 재인덱싱을 요청합니다.
    on("indexing/reindex", async (msg) => {
      if (msg.data.type === "docs") {
        void this.docsService.reindexDoc(msg.data.id);
      }
    });
    // 문서(Docs) 인덱싱 중단을 요청합니다.
    on("indexing/abort", async (msg) => {
      if (msg.data.type === "docs") {
        this.docsService.abort(msg.data.id);
      }
    });
    // 문서(Docs) 인덱싱 일시정지(현재는 동작 없음)
    on("indexing/setPaused", async (msg) => {
      if (msg.data.type === "docs") {
      }
    });
    // 문서(Docs) 상태 초기화 요청을 처리합니다.
    on("docs/initStatuses", async (msg) => {
      void this.docsService.initStatuses();
    });
    // 특정 문서(Docs)의 상세 정보를 요청합니다.
    on("docs/getDetails", async (msg) => {
      return await this.docsService.getDetails(msg.data.startUrl);
    });

    // 선택된 프로필이 변경되었을 때 처리합니다.
    on("didChangeSelectedProfile", async (msg) => {
      if (msg.data.id) {
        await this.configHandler.setSelectedProfileId(msg.data.id);
      }
    });

    // 선택된 조직(Org)이 변경되었을 때 처리합니다.
    on("didChangeSelectedOrg", async (msg) => {
      if (msg.data.id) {
        await this.configHandler.setSelectedOrgId(
          msg.data.id,
          msg.data.profileId || undefined,
        );
      }
    });

    // 컨트롤 플레인 세션 정보가 변경되었을 때 세션 정보를 갱신합니다.
    on("didChangeControlPlaneSessionInfo", async (msg) => {
      this.messenger.send("sessionUpdate", {
        sessionInfo: msg.data.sessionInfo,
      });
      await this.configHandler.updateControlPlaneSessionInfo(
        msg.data.sessionInfo,
      );
    });

    // 인증 URL을 요청합니다. (토큰 발급 페이지 등)
    on("auth/getAuthUrl", async (msg) => {
      const url = await getAuthUrlForTokenPage(
        ideSettingsPromise,
        msg.data.useOnboarding,
      );
      return { url };
    });

    // 활성 텍스트 에디터가 변경되었을 때 최근 편집 파일 캐시에 추가합니다.
    on("didChangeActiveTextEditor", async ({ data: { filepath } }) => {
      try {
        const ignore = await shouldIgnore(filepath, this.ide);
        if (!ignore) {
          recentlyEditedFilesCache.set(filepath, filepath);
        }
      } catch (e) {
        console.error(
          `didChangeActiveTextEditor: failed to update recentlyEditedFiles cache for ${filepath}`,
        );
      }
    });

    // 툴 호출 요청을 처리합니다. (툴 실행 및 결과 반환)
    on("tools/call", async ({ data: { toolCall } }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        throw new Error("Config not loaded");
      }

      const tool = config.tools.find(
        (t) => t.function.name === toolCall.function.name,
      );

      if (!tool) {
        throw new Error(`Tool ${toolCall.function.name} not found`);
      }

      if (!config.selectedModelByRole.chat) {
        throw new Error("No chat model selected");
      }

      // Define a callback for streaming output updates
      const onPartialOutput = (params: {
        toolCallId: string;
        contextItems: ContextItem[];
      }) => {
        this.messenger.send("toolCallPartialOutput", params);
      };

      return await callTool(tool, toolCall.function.arguments, {
        ide: this.ide,
        llm: config.selectedModelByRole.chat,
        fetch: (url, init) =>
          fetchwithRequestOptions(url, init, config.requestOptions),
        tool,
        toolCallId: toolCall.id,
        onPartialOutput,
      });
    });

    // 컨텍스트 아이템이 LLM의 컨텍스트 길이보다 큰지 확인합니다.
    on("isItemTooBig", async ({ data: { item } }) => {
      return this.isItemTooBig(item);
    });

    // 프로세스를 백그라운드로 표시합니다. (툴 실행 상태 관리)
    on("process/markAsBackgrounded", async ({ data: { toolCallId } }) => {
      markProcessAsBackgrounded(toolCallId);
    });
    // 프로세스가 백그라운드 상태인지 확인합니다.
    on(
      "process/isBackgrounded",
      async ({ data: { toolCallId }, messageId }) => {
        const isBackgrounded = isProcessBackgrounded(toolCallId);
        return isBackgrounded; // Return true to indicate the message was handled successfully
      },
    );
  }

  /**
   * 주어진 컨텍스트 아이템이 현재 LLM에 비해 너무 큰지 확인합니다.
   * @param item ContextItemWithId
   * @returns 아이템이 너무 크면 true, 아니면 false를 반환합니다.
   */
  private async isItemTooBig(item: ContextItemWithId) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return false;
    }

    const llm = config?.selectedModelByRole.chat;
    if (!llm) {
      throw new Error("No chat model selected");
    }

    const tokens = countTokens(item.content, llm.model);

    if (tokens > llm.contextLength - llm.completionOptions!.maxTokens!) {
      return true;
    }

    return false;
  }

  /**
   * 주어진 디렉토리들에 대해 코드베이스 인덱스를 새로 고칩니다.
   * @param dirs 인덱스를 새로 고칠 디렉토리들입니다.
   */
  private handleAddAutocompleteModel(
    msg: Message<{
      model: ModelDescription;
    }>,
  ) {
    const model = msg.data.model;
    editConfigFile(
      (config) => {
        return {
          ...config,
          tabAutocompleteModel: model,
        };
      },
      (config) => ({
        ...config,
        models: [
          ...(config.models ?? []),
          {
            name: model.title,
            provider: model.provider,
            model: model.model,
            apiKey: model.apiKey,
            roles: ["autocomplete"],
            apiBase: model.apiBase,
          },
        ],
      }),
    );
    void this.configHandler.reloadConfig();
  }

  /**
   * 주어진 디렉토리들에 대해 코드베이스 인덱스를 새로 고칩니다.
   * @param uris 인덱스를 새로 고칠 디렉토리들입니다.
   */
  private async handleFilesChanged({
    data,
  }: Message<{
    uris?: string[];
  }>) {
    if (data?.uris?.length) {
      walkDirCache.invalidate(); // safe approach for now - TODO - only invalidate on relevant changes
      for (const uri of data.uris) {
        const currentProfileUri =
          this.configHandler.currentProfile?.profileDescription.uri ?? "";

        if (URI.equal(uri, currentProfileUri)) {
          // Trigger a toast notification to provide UI feedback that config has been updated
          const showToast =
            this.globalContext.get("showConfigUpdateToast") ?? true;
          if (showToast) {
            const selection = await this.ide.showToast(
              "info",
              "Config updated",
              "Don't show again",
            );
            if (selection === "Don't show again") {
              this.globalContext.update("showConfigUpdateToast", false);
            }
          }
          await this.configHandler.reloadConfig();
          continue;
        }

        if (
          uri.endsWith(".continuerc.json") ||
          uri.endsWith(".prompt") ||
          uri.endsWith(SYSTEM_PROMPT_DOT_FILE) ||
          (uri.includes(".continue") && uri.endsWith(".yaml"))
        ) {
          await this.configHandler.reloadConfig();
        } else if (
          uri.endsWith(".continueignore") ||
          uri.endsWith(".gitignore")
        ) {
          // Reindex the workspaces
          this.invoke("index/forceReIndex", {
            shouldClearIndexes: true,
          });
        } else {
          const { config } = await this.configHandler.loadConfig();
          if (config && !config.disableIndexing) {
            // Reindex the file
            const ignore = await shouldIgnore(uri, this.ide);
            if (!ignore) {
              await this.refreshCodebaseIndexFiles([uri]);
            }
          }
        }
      }
    }
  }

  /**
   * 주어진 디렉토리들에 대해 코드베이스 인덱스를 새로 고칩니다.
   * @param uris 인덱스를 새로 고칠 디렉토리들입니다.
   */
  private async handleListModels(msg: Message<{ title: string }>) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const model =
      config.modelsByRole.chat.find(
        (model) => model.title === msg.data.title,
      ) ??
      config.modelsByRole.chat.find((model) =>
        model.title?.startsWith(msg.data.title),
      );

    try {
      if (model) {
        return await model.listModels();
      } else {
        if (msg.data.title === "Ollama") {
          const models = await new Ollama({ model: "" }).listModels();
          return models;
        } else {
          return undefined;
        }
      }
    } catch (e) {
      console.debug(`Error listing Ollama models: ${e}`);
      return undefined;
    }
  }

  /**
   * 자동완성 모델을 추가합니다.
   * @param msg 메시지 객체
   */
  private async handleCompleteOnboarding(msg: Message<{ mode: string }>) {
    const mode = msg.data.mode;

    if (mode === "Custom") {
      return;
    }

    let editConfigYamlCallback: (config: ConfigYaml) => ConfigYaml;

    switch (mode) {
      case "Local":
        editConfigYamlCallback = setupLocalConfig;
        break;

      case "Quickstart":
        editConfigYamlCallback = setupQuickstartConfig;
        break;

      case "Best":
        editConfigYamlCallback = setupBestConfig;
        break;

      default:
        console.error(`Invalid mode: ${mode}`);
        editConfigYamlCallback = (config) => config;
    }

    editConfigFile((c) => c, editConfigYamlCallback);

    void this.configHandler.reloadConfig();
  }

  /**
   * 코드베이스 인덱스를 새로 고칩니다.
   * @param dirs 인덱싱할 디렉토리 목록
   */
  private getContextItems = async (
    msg: Message<{
      name: string;
      query: string;
      fullInput: string;
      selectedCode: RangeInFile[];
    }>,
  ) => {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const { name, query, fullInput, selectedCode } = msg.data;

    const llm = (await this.configHandler.loadConfig()).config
      ?.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No chat model selected");
    }

    const provider =
      config.contextProviders?.find(
        (provider) => provider.description.title === name,
      ) ??
      [
        // user doesn't need these in their config.json for the shortcuts to work
        // option+enter
        new CurrentFileContextProvider({}),
        // cmd+enter
        new CodebaseContextProvider({}),
      ].find((provider) => provider.description.title === name);
    if (!provider) {
      return [];
    }

    try {
      const id: ContextItemId = {
        providerTitle: provider.description.title,
        itemId: uuidv4(),
      };

      const items = await provider.getContextItems(query, {
        config,
        llm,
        embeddingsProvider: config.selectedModelByRole.embed,
        fullInput,
        ide: this.ide,
        selectedCode,
        reranker: config.selectedModelByRole.rerank,
        fetch: (url, init) =>
          fetchwithRequestOptions(url, init, config.requestOptions),
      });

      void Telemetry.capture(
        "useContextProvider",
        {
          name: provider.description.title,
        },
        true,
      );

      return items.map((item) => ({
        ...item,
        id,
      }));
    } catch (e) {
      let knownError = false;

      if (e instanceof Error) {
        // After removing transformers JS embeddings provider from jetbrains
        // Should no longer see this error
        // if (e.message.toLowerCase().includes("embeddings provider")) {
        //   knownError = true;
        //   const toastOption = "See Docs";
        //   void this.ide
        //     .showToast(
        //       "error",
        //       `Set up an embeddings model to use @${name}`,
        //       toastOption,
        //     )
        //     .then((userSelection) => {
        //       if (userSelection === toastOption) {
        //         void this.ide.openUrl(
        //           "https://docs.continue.dev/customize/model-roles/embeddings",
        //         );
        //       }
        //     });
        // }
      }
      if (!knownError) {
        void this.ide.showToast(
          "error",
          `Error getting context items from ${name}: ${e}`,
        );
      }
      return [];
    }
  };

  /**
   * 인덱싱 취소 컨트롤러입니다.
   * 인덱싱 작업을 취소할 때 사용됩니다.
   */
  private indexingCancellationController: AbortController | undefined;

  /**
   * 인덱싱 오류에 대한 텔레메트리를 전송합니다.
   * @param update 인덱싱 진행 업데이트입니다.
   */
  private async sendIndexingErrorTelemetry(update: IndexingProgressUpdate) {
    console.debug(
      "Indexing failed with error: ",
      update.desc,
      update.debugInfo,
    );
    void Telemetry.capture(
      "indexing_error",
      {
        error: update.desc,
        stack: update.debugInfo,
      },
      false,
    );
  }

  /**
   * 주어진 디렉토리들에 대해 코드베이스 인덱스를 새로 고칩니다.
   * @param paths 인덱스를 새로 고칠 디렉토리들입니다.
   */
  private async refreshCodebaseIndex(paths: string[]) {
    if (this.indexingCancellationController) {
      this.indexingCancellationController.abort();
    }
    this.indexingCancellationController = new AbortController();
    try {
      for await (const update of (
        await this.codebaseIndexerPromise
      ).refreshDirs(paths, this.indexingCancellationController.signal)) {
        let updateToSend = { ...update };

        void this.messenger.request("indexProgress", updateToSend);
        this.codebaseIndexingState = updateToSend;

        if (update.status === "failed") {
          void this.sendIndexingErrorTelemetry(update);
        }
      }
    } catch (e: any) {
      console.log(`Failed refreshing codebase index directories : ${e}`);
      this.handleIndexingError(e);
    }

    this.messenger.send("refreshSubmenuItems", {
      providers: "dependsOnIndexing",
    });
    this.indexingCancellationController = undefined;
  }

  /**
   * 주어진 파일들에 대해 코드베이스 인덱스를 새로 고칩니다.
   * @param files 인덱스를 새로 고칠 파일들입니다.
   */
  private async refreshCodebaseIndexFiles(files: string[]) {
    // Can be cancelled by codebase index but not vice versa
    if (
      this.indexingCancellationController &&
      !this.indexingCancellationController.signal.aborted
    ) {
      return;
    }
    this.indexingCancellationController = new AbortController();
    try {
      for await (const update of (
        await this.codebaseIndexerPromise
      ).refreshFiles(files)) {
        let updateToSend = { ...update };

        void this.messenger.request("indexProgress", updateToSend);
        this.codebaseIndexingState = updateToSend;

        if (update.status === "failed") {
          void this.sendIndexingErrorTelemetry(update);
        }
      }
    } catch (e: any) {
      console.log(`Failed refreshing codebase index files : ${e}`);
      this.handleIndexingError(e);
    }

    this.messenger.send("refreshSubmenuItems", {
      providers: "dependsOnIndexing",
    });
    this.indexingCancellationController = undefined;
  }

  // private
  /**
   * 인덱싱 중 발생한 오류를 처리합니다.
   * @param e 발생한 오류입니다.
   */
  handleIndexingError(e: any) {
    if (e instanceof LLMError) {
      // Need to report this specific error to the IDE for special handling
      void this.messenger.request("reportError", e);
    }
    // broadcast indexing error
    let updateToSend: IndexingProgressUpdate = {
      progress: 0,
      status: "failed",
      desc: e.message,
    };
    void this.messenger.request("indexProgress", updateToSend);
    this.codebaseIndexingState = updateToSend;
    void this.sendIndexingErrorTelemetry(updateToSend);
  }
}
