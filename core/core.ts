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

  private readonly indexingPauseToken = new PauseToken(
    this.globalContext.get("indexingPaused") === true,
  );

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
   * 주어진 메시지 ID에 대한 AbortController를 중단합니다.
   *
   * @param messageId - 중단할 메시지 ID
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

    MCPManagerSingleton.getInstance().onConnectionsRefreshed = async () => {
      await this.configHandler.reloadConfig();
    };

    // Register the config handler with the messenger
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

    on("abort", (msg) => {
      this.abortById(msg.data ?? msg.messageId);
    });

    on("ping", (msg) => {
      if (msg.data !== "ping") {
        throw new Error("ping message incorrect");
      }
      return "pong";
    });

    // History
    on("history/list", (msg) => {
      return historyManager.list(msg.data);
    });

    on("history/delete", (msg) => {
      historyManager.delete(msg.data.id);
    });

    on("history/load", (msg) => {
      return historyManager.load(msg.data.id);
    });

    on("history/save", (msg) => {
      historyManager.save(msg.data);
    });

    on("history/clear", (msg) => {
      historyManager.clearAll();
    });

    on("devdata/log", async (msg) => {
      void DataLogger.getInstance().logDevData(msg.data);
    });

    on("config/addModel", (msg) => {
      const model = msg.data.model;
      addModel(model, msg.data.role);
      void this.configHandler.reloadConfig();
    });

    on("config/deleteModel", (msg) => {
      deleteModel(msg.data.title);
      void this.configHandler.reloadConfig();
    });

    on("config/newPromptFile", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      await createNewPromptFileV2(this.ide, config?.experimental?.promptPath);
      await this.configHandler.reloadConfig();
    });

    on("config/addLocalWorkspaceBlock", async (msg) => {
      await createNewWorkspaceBlockFile(this.ide, msg.data.blockType);
      await this.configHandler.reloadConfig();
    });

    on("config/openProfile", async (msg) => {
      await this.configHandler.openConfigProfile(msg.data.profileId);
    });

    on("config/reload", async (msg) => {
      void this.configHandler.reloadConfig();
      return await this.configHandler.getSerializedConfig();
    });

    on("config/ideSettingsUpdate", async (msg) => {
      await this.configHandler.updateIdeSettings(msg.data);
    });

    on("config/refreshProfiles", async (msg) => {
      const { selectOrgId, selectProfileId } = msg.data ?? {};
      await this.configHandler.refreshAll();
      if (selectOrgId) {
        await this.configHandler.setSelectedOrgId(selectOrgId, selectProfileId);
      } else if (selectProfileId) {
        await this.configHandler.setSelectedProfileId(selectProfileId);
      }
    });

    on("config/updateSharedConfig", async (msg) => {
      const newSharedConfig = this.globalContext.updateSharedConfig(msg.data);
      await this.configHandler.reloadConfig();
      return newSharedConfig;
    });

    on("config/updateSelectedModel", async (msg) => {
      const newSelectedModels = this.globalContext.updateSelectedModel(
        msg.data.profileId,
        msg.data.role,
        msg.data.title,
      );
      await this.configHandler.reloadConfig();
      return newSelectedModels;
    });

    on("controlPlane/openUrl", async (msg) => {
      const env = await getControlPlaneEnv(this.ide.getIdeSettings());
      let url = `${env.APP_URL}${msg.data.path}`;
      if (msg.data.orgSlug) {
        url += `?org=${msg.data.orgSlug}`;
      }
      await this.messenger.request("openUrl", url);
    });

    on("mcp/reloadServer", async (msg) => {
      await MCPManagerSingleton.getInstance().refreshConnection(msg.data.id);
    });
    // Context providers
    on("context/addDocs", async (msg) => {
      void this.docsService.indexAndAdd(msg.data);
    });

    on("context/removeDocs", async (msg) => {
      await this.docsService.delete(msg.data.startUrl);
    });

    on("context/indexDocs", async (msg) => {
      await this.docsService.syncDocsWithPrompt(msg.data.reIndex);
    });

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

    on("context/getContextItems", this.getContextItems.bind(this));

    on("context/getSymbolsForFiles", async (msg) => {
      const { uris } = msg.data;
      return await getSymbolsForManyFiles(uris, this.ide);
    });

    on("config/getSerializedProfileInfo", async (msg) => {
      return {
        result: await this.configHandler.getSerializedConfig(),
        profileId:
          this.configHandler.currentProfile?.profileDescription.id ?? null,
        organizations: this.configHandler.getSerializedOrgs(),
        selectedOrgId: this.configHandler.currentOrg.id,
      };
    });

    on("clipboardCache/add", (msg) => {
      const added = clipboardCache.add(uuidv4(), msg.data.content);
      if (added) {
        this.messenger.send("refreshSubmenuItems", {
          providers: ["clipboard"],
        });
      }
    });

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
    on("llm/listModels", this.handleListModels.bind(this));

    // Provide messenger to utils so they can interact with GUI + state
    TTS.messenger = this.messenger;
    ChatDescriber.messenger = this.messenger;

    on("tts/kill", async () => {
      void TTS.kill();
    });

    on("chatDescriber/describe", async (msg) => {
      const currentModel = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!currentModel) {
        throw new Error("No chat model selected");
      }

      return await ChatDescriber.describe(currentModel, {}, msg.data.text);
    });

    // Autocomplete
    on("autocomplete/complete", async (msg) => {
      const outcome =
        await this.completionProvider.provideInlineCompletionItems(
          msg.data,
          undefined,
        );
      return outcome ? [outcome.completion] : [];
    });
    on("autocomplete/accept", async (msg) => {
      this.completionProvider.accept(msg.data.completionId);
    });
    on("autocomplete/cancel", async (msg) => {
      this.completionProvider.cancel();
    });

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

    on("cancelApply", async (msg) => {
      const abortManager = StreamAbortManager.getInstance();
      abortManager.clear();
    });

    on("completeOnboarding", this.handleCompleteOnboarding.bind(this));

    on("addAutocompleteModel", this.handleAddAutocompleteModel.bind(this));

    on("stats/getTokensPerDay", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerDay();
      return rows;
    });
    on("stats/getTokensPerModel", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerModel();
      return rows;
    });

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
    on("index/setPaused", (msg) => {
      this.globalContext.update("indexingPaused", msg.data);
      this.indexingPauseToken.paused = msg.data;
    });

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

    // File changes - TODO - remove remaining logic for these from IDEs where possible
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

    on("files/deleted", async ({ data }) => {
      if (data?.uris?.length) {
        walkDirCache.invalidate();
        void refreshIfNotIgnored(data.uris);
      }
    });

    on("files/closed", async ({ data }) => {
      if (data.uris) {
        this.messenger.send("didCloseFiles", {
          uris: data.uris,
        });
      }
    });

    on("files/opened", async () => {});

    // Docs, etc. indexing
    on("indexing/reindex", async (msg) => {
      if (msg.data.type === "docs") {
        void this.docsService.reindexDoc(msg.data.id);
      }
    });
    on("indexing/abort", async (msg) => {
      if (msg.data.type === "docs") {
        this.docsService.abort(msg.data.id);
      }
    });
    on("indexing/setPaused", async (msg) => {
      if (msg.data.type === "docs") {
      }
    });
    on("docs/initStatuses", async (msg) => {
      void this.docsService.initStatuses();
    });
    on("docs/getDetails", async (msg) => {
      return await this.docsService.getDetails(msg.data.startUrl);
    });

    on("didChangeSelectedProfile", async (msg) => {
      if (msg.data.id) {
        await this.configHandler.setSelectedProfileId(msg.data.id);
      }
    });

    on("didChangeSelectedOrg", async (msg) => {
      if (msg.data.id) {
        await this.configHandler.setSelectedOrgId(
          msg.data.id,
          msg.data.profileId || undefined,
        );
      }
    });

    on("didChangeControlPlaneSessionInfo", async (msg) => {
      this.messenger.send("sessionUpdate", {
        sessionInfo: msg.data.sessionInfo,
      });
      await this.configHandler.updateControlPlaneSessionInfo(
        msg.data.sessionInfo,
      );
    });

    on("auth/getAuthUrl", async (msg) => {
      const url = await getAuthUrlForTokenPage(
        ideSettingsPromise,
        msg.data.useOnboarding,
      );
      return { url };
    });

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

    on("isItemTooBig", async ({ data: { item } }) => {
      return this.isItemTooBig(item);
    });

    // Process state handlers
    on("process/markAsBackgrounded", async ({ data: { toolCallId } }) => {
      markProcessAsBackgrounded(toolCallId);
    });

    on(
      "process/isBackgrounded",
      async ({ data: { toolCallId }, messageId }) => {
        const isBackgrounded = isProcessBackgrounded(toolCallId);
        return isBackgrounded; // Return true to indicate the message was handled successfully
      },
    );
  }

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
   * Handles the addition of a new autocomplete model to the configuration.
   *
   * This method processes an incoming message containing a `ModelDescription` object,
   * updates the configuration to set the `tabAutocompleteModel`, and appends the new model
   * to the list of available models with the "autocomplete" role. After updating the configuration,
   * it triggers a reload of the configuration handler.
   *
   * @param msg - The message containing the model description to add.
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
   * Handles file changes by invalidating the walkDirCache and refreshing the codebase index
   * for relevant files based on their URIs.
   *
   * @param data - The message data containing an array of file URIs that have changed.
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
   * Refreshes the codebase index for a list of file URIs.
   *
   * This method checks if the provided file URIs are not ignored, and if they are valid,
   * it triggers a re-indexing of those files in the codebase.
   *
   * @param uris - An array of file URIs to refresh in the codebase index.
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
   * Handles the completion of the onboarding process by setting up the configuration
   * based on the selected mode.
   *
   * @param msg - The message containing the mode for onboarding completion.
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
   * Retrieves context items based on the provided message data.
   *
   * This method uses the specified context provider to fetch context items
   * based on the query and other parameters provided in the message.
   *
   * @param msg - The message containing the context provider name, query, full input,
   *              and selected code ranges.
   * @returns An array of context items retrieved from the specified provider.
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

  private indexingCancellationController: AbortController | undefined;

  /**
   * Sends telemetry for an indexing error.
   *
   * @param update - The indexing progress update containing error details.
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
   * Refreshes the codebase index for a list of directory paths.
   *
   * This method cancels any ongoing indexing operation, sets up a new cancellation controller,
   * and iterates through the provided paths to refresh the index for each directory.
   * It sends progress updates and handles any errors that occur during the indexing process.
   *
   * @param paths - An array of directory paths to refresh in the codebase index.
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
