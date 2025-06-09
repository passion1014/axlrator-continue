import { ConfigResult } from "@continuedev/config-yaml";

import { ControlPlaneClient } from "../control-plane/client.js";
import {
  BrowserSerializedContinueConfig,
  ContinueConfig,
  IContextProvider,
  IDE,
  IdeSettings,
  ILLMLogger,
} from "../index.js";
import { GlobalContext } from "../util/GlobalContext.js";

import {
  AuthType,
  ControlPlaneSessionInfo,
} from "../control-plane/AuthTypes.js";
import { getControlPlaneEnv } from "../control-plane/env.js";
import { logger } from "../util/logger.js";
import {
  ASSISTANTS,
  getAllDotContinueDefinitionFiles,
  LoadAssistantFilesOptions,
} from "./loadLocalAssistants.js";
import LocalProfileLoader from "./profile/LocalProfileLoader.js";
import PlatformProfileLoader from "./profile/PlatformProfileLoader.js";
import {
  OrganizationDescription,
  OrgWithProfiles,
  ProfileDescription,
  ProfileLifecycleManager,
  SerializedOrgWithProfiles,
} from "./ProfileLifecycleManager.js";

export type { ProfileDescription };

type ConfigUpdateFunction = (payload: ConfigResult<ContinueConfig>) => void;

/**
 * ConfigHandler is responsible for managing the configuration of the IDE,
 */
/**
 * 구성 및 프로필 관리를 담당하는 핸들러 클래스입니다.
 *
 * 이 클래스는 IDE, 조직, 프로필, 세션 정보 등을 바탕으로
 * 다양한 조직 및 프로필의 라이프사이클을 관리하고,
 * 현재 선택된 조직 및 프로필을 추적하며,
 * 구성 변경 시 리스너에게 알림을 제공합니다.
 *
 * 주요 기능:
 * - 조직 및 프로필 목록 로드 및 직렬화
 * - 현재 조직/프로필 선택 및 변경
 * - 구성 로드 및 갱신
 * - 외부 컨텍스트 제공자 등록 및 관리
 * - 구성 변경 리스너 등록 및 알림
 *
 * @remarks
 * - 조직 및 프로필 선택 정보는 워크스페이스별로 저장됩니다.
 * - 로컬 및 허브 프로필을 모두 지원합니다.
 * - 세션 또는 IDE 설정 변경 시 자동으로 구성을 재로드합니다.
 */
export class ConfigHandler {
  controlPlaneClient: ControlPlaneClient;
  private readonly globalContext = new GlobalContext();
  private globalLocalProfileManager: ProfileLifecycleManager;

  private organizations: OrgWithProfiles[] = [];
  currentProfile: ProfileLifecycleManager | null;
  currentOrg: OrgWithProfiles;

  constructor(
    private readonly ide: IDE,
    private ideSettingsPromise: Promise<IdeSettings>,
    private llmLogger: ILLMLogger,
    sessionInfoPromise: Promise<ControlPlaneSessionInfo | undefined>,
  ) {
    this.ide = ide;
    this.ideSettingsPromise = ideSettingsPromise;
    this.controlPlaneClient = new ControlPlaneClient(
      sessionInfoPromise,
      ideSettingsPromise,
    );

    // This profile manager will always be available
    this.globalLocalProfileManager = new ProfileLifecycleManager(
      new LocalProfileLoader(
        ide,
        ideSettingsPromise,
        this.controlPlaneClient,
        this.llmLogger,
      ),
      this.ide,
    );

    // Just to be safe, always force a default personal org with local profile manager
    this.currentProfile = this.globalLocalProfileManager;
    const personalOrg: OrgWithProfiles = {
      currentProfile: this.globalLocalProfileManager,
      profiles: [this.globalLocalProfileManager],
      ...this.PERSONAL_ORG_DESC,
    };

    this.currentOrg = personalOrg;
    this.organizations = [personalOrg];

    void this.cascadeInit();
  }

  private workspaceDirs: string[] | null = null;

  /**
   * 워크스페이스 디렉터리를 조인하여 워크스페이스 ID를 반환합니다.
   * 이 값은 구성 식별을 위해 워크스페이스를 고유하게 식별하는 데 사용됩니다.
   * @returns 워크스페이스 ID 문자열
   */
  async getWorkspaceId() {
    if (!this.workspaceDirs) {
      this.workspaceDirs = await this.ide.getWorkspaceDirs();
    }
    return this.workspaceDirs.join("&");
  }

  /**
   * 조직 ID와 워크스페이스 ID를 기반으로 프로필에 대한 고유 키를 생성합니다.
   * @param orgId - 조직 ID
   * @returns 프로필 키 문자열
   */
  async getProfileKey(orgId: string) {
    const workspaceId = await this.getWorkspaceId();
    return `${workspaceId}:::${orgId}`;
  }

  /**
   * 구성 핸들러를 초기화하여 조직을 로드하고 현재 조직 및 프로필을 설정합니다.
   * 이 메서드는 초기 설정 시와 세션 또는 IDE 설정이 변경될 때 호출됩니다.
   */
  private async cascadeInit() {
    this.workspaceDirs = null; // forces workspace dirs reload

    const orgs = await this.getOrgs();

    // Figure out selected org
    const workspaceId = await this.getWorkspaceId();
    const selectedOrgs =
      this.globalContext.get("lastSelectedOrgIdForWorkspace") ?? {};
    const currentSelection = selectedOrgs[workspaceId];

    const firstNonPersonal = orgs.find(
      (org) => org.id !== this.PERSONAL_ORG_DESC.id,
    );
    const fallback = firstNonPersonal ?? orgs[0];
    // note, ignoring case of zero orgs since should never happen

    let selectedOrg: OrgWithProfiles;
    if (!currentSelection) {
      selectedOrg = fallback;
    } else {
      const match = orgs.find((org) => org.id === currentSelection);
      if (match) {
        selectedOrg = match;
      } else {
        selectedOrg = fallback;
      }
    }

    this.globalContext.update("lastSelectedOrgIdForWorkspace", {
      ...selectedOrgs,
      [workspaceId]: selectedOrg.id,
    });

    this.organizations = orgs;
    this.currentOrg = selectedOrg;
    this.currentProfile = selectedOrg.currentProfile;
    await this.reloadConfig();
  }

  /**
   * Retrieves the organizations with profiles, including local and hub profiles.
   * @returns An array of organizations with profiles.
   */
  private async getOrgs(): Promise<OrgWithProfiles[]> {
    if (await this.controlPlaneClient.isSignedIn()) {
      const orgDescs = await this.controlPlaneClient.listOrganizations();
      const personalHubOrg = await this.getPersonalHubOrg();
      const hubOrgs = await Promise.all(
        orgDescs.map((org) => this.getNonPersonalHubOrg(org)),
      );
      return [...hubOrgs, personalHubOrg];
    } else {
      return [await this.getLocalOrg()];
    }
  }

  /**
   * 직렬화된 조직 및 프로필 목록을 반환합니다.
   * @returns 직렬화된 조직 및 프로필 배열
   */
  getSerializedOrgs(): SerializedOrgWithProfiles[] {
    return this.organizations.map((org) => ({
      iconUrl: org.iconUrl,
      id: org.id,
      name: org.name,
      slug: org.slug,
      profiles: org.profiles.map((profile) => profile.profileDescription),
      selectedProfileId: org.currentProfile?.profileDescription.id || null,
    }));
  }

  /**
   * Retrieves the hub profiles for a given organization scope.
   * @param orgScopeId - The ID of the organization scope, or null for personal hub.
   * @returns An array of profile lifecycle managers for the hub profiles.
   */
  private async getHubProfiles(orgScopeId: string | null) {
    const assistants = await this.controlPlaneClient.listAssistants(orgScopeId);

    return await Promise.all(
      assistants.map(async (assistant) => {
        const profileLoader = await PlatformProfileLoader.create({
          configResult: {
            ...assistant.configResult,
            config: assistant.configResult.config,
          },
          ownerSlug: assistant.ownerSlug,
          packageSlug: assistant.packageSlug,
          iconUrl: assistant.iconUrl,
          versionSlug: assistant.configResult.config?.version ?? "latest",
          controlPlaneClient: this.controlPlaneClient,
          ide: this.ide,
          ideSettingsPromise: this.ideSettingsPromise,
          llmLogger: this.llmLogger,
          rawYaml: assistant.rawYaml,
          orgScopeId: orgScopeId,
        });

        return new ProfileLifecycleManager(profileLoader, this.ide);
      }),
    );
  }

  /**
   * 개인이 아닌 허브 조직에 대한 프로필이 포함된 조직을 반환합니다.
   * @param org - 조직 설명
   * @returns 프로필과 현재 프로필이 포함된 조직 객체
   */
  private async getNonPersonalHubOrg(
    org: OrganizationDescription,
  ): Promise<OrgWithProfiles> {
    const localProfiles = await this.getLocalProfiles({
      includeGlobal: false,
      includeWorkspace: true,
    });
    const profiles = [...(await this.getHubProfiles(org.id)), ...localProfiles];
    return this.rectifyProfilesForOrg(org, profiles);
  }

  /**
   * 로컬 프로필과 허브 프로필이 포함된 개인 조직 설명입니다.
   */
  private PERSONAL_ORG_DESC: OrganizationDescription = {
    iconUrl: "",
    id: "personal",
    name: "Personal",
    slug: undefined,
  };

  /**
   * 개인 조직(로컬 프로필과 허브 프로필 포함)을 반환합니다.
   * @returns 프로필과 현재 프로필이 포함된 개인 조직 객체
   */
  private async getPersonalHubOrg() {
    const localProfiles = await this.getLocalProfiles({
      includeGlobal: true,
      includeWorkspace: true,
    });
    const hubProfiles = await this.getHubProfiles(null);
    const profiles = [...hubProfiles, ...localProfiles];
    return this.rectifyProfilesForOrg(this.PERSONAL_ORG_DESC, profiles);
  }

  /**
   * 로컬 프로필만 포함된 로컬 조직을 반환합니다.
   * @returns 로컬 프로필이 포함된 개인 조직 객체
   */
  private async getLocalOrg() {
    const localProfiles = await this.getLocalProfiles({
      includeGlobal: true,
      includeWorkspace: true,
    });
    return this.rectifyProfilesForOrg(this.PERSONAL_ORG_DESC, localProfiles);
  }

  /**
   * 조직에 대한 프로필을 정리하여 현재 프로필을 올바르게 설정합니다.
   * @param org - 조직 설명
   * @param profiles - 프로필 라이프사이클 매니저 목록
   * @returns 프로필과 현재 프로필이 포함된 조직 객체
   */
  private async rectifyProfilesForOrg(
    org: OrganizationDescription,
    profiles: ProfileLifecycleManager[],
  ): Promise<OrgWithProfiles> {
    const profileKey = await this.getProfileKey(org.id);
    const selectedProfiles =
      this.globalContext.get("lastSelectedProfileForWorkspace") ?? {};

    const currentSelection = selectedProfiles[profileKey];

    const firstNonLocal = profiles.find(
      (profile) => profile.profileDescription.profileType !== "local",
    );
    const fallback =
      firstNonLocal ?? (profiles.length > 0 ? profiles[0] : null);

    let currentProfile: ProfileLifecycleManager | null;
    if (!currentSelection) {
      currentProfile = fallback;
    } else {
      const match = profiles.find(
        (profile) => profile.profileDescription.id === currentSelection,
      );
      if (match) {
        currentProfile = match;
      } else {
        currentProfile = fallback;
      }
    }

    if (currentProfile) {
      this.globalContext.update("lastSelectedProfileForWorkspace", {
        ...selectedProfiles,
        [profileKey]: currentProfile.profileDescription.id,
      });
    }

    return {
      ...org,
      profiles,
      currentProfile,
    };
  }

  async getLocalProfiles(options: LoadAssistantFilesOptions) {
    /**
     * Users can define as many local assistants as they want in a `.continue/assistants` folder
     */

    // Local customization disabled for on-premise deployments
    const env = await getControlPlaneEnv(this.ide.getIdeSettings());
    if (env.AUTH_TYPE === AuthType.OnPrem) {
      return [];
    }

    const localProfiles: ProfileLifecycleManager[] = [];

    if (options.includeGlobal) {
      localProfiles.push(this.globalLocalProfileManager);
    }

    if (options.includeWorkspace) {
      const assistantFiles = await getAllDotContinueDefinitionFiles(
        this.ide,
        options,
        ASSISTANTS,
      );
      const profiles = assistantFiles.map((assistant) => {
        return new LocalProfileLoader(
          this.ide,
          this.ideSettingsPromise,
          this.controlPlaneClient,
          this.llmLogger,
          assistant,
        );
      });
      const localAssistantProfiles = profiles.map(
        (profile) => new ProfileLifecycleManager(profile, this.ide),
      );
      localProfiles.push(...localAssistantProfiles);
    }

    return localProfiles;
  }

  //////////////////
  // External actions that can cause a cascading config refresh
  // Should not be used internally
  //////////////////
  async refreshAll() {
    await this.cascadeInit();
  }

  // Ide settings change: refresh session and cascade refresh from the top
  async updateIdeSettings(ideSettings: IdeSettings) {
    this.ideSettingsPromise = Promise.resolve(ideSettings);
    await this.cascadeInit();
  }

  // Session change: refresh session and cascade refresh from the top
  async updateControlPlaneSessionInfo(
    sessionInfo: ControlPlaneSessionInfo | undefined,
  ) {
    this.controlPlaneClient = new ControlPlaneClient(
      Promise.resolve(sessionInfo),
      this.ideSettingsPromise,
    );
    await this.cascadeInit();
  }

  // Org id: check id validity, save selection, switch and reload
  async setSelectedOrgId(orgId: string, profileId?: string) {
    if (orgId === this.currentOrg.id) {
      return;
    }
    const org = this.organizations.find((org) => org.id === orgId);
    if (!org) {
      throw new Error(`Org ${orgId} not found`);
    }

    const workspaceId = await this.getWorkspaceId();
    const selectedOrgs =
      this.globalContext.get("lastSelectedOrgIdForWorkspace") ?? {};
    this.globalContext.update("lastSelectedOrgIdForWorkspace", {
      ...selectedOrgs,
      [workspaceId]: org.id,
    });

    this.currentOrg = org;

    if (profileId) {
      await this.setSelectedProfileId(profileId);
    } else {
      this.currentProfile = org.currentProfile;
      await this.reloadConfig();
    }
  }

  // Profile id: check id validity, save selection, switch and reload
  async setSelectedProfileId(profileId: string) {
    if (
      this.currentProfile &&
      profileId === this.currentProfile.profileDescription.id
    ) {
      return;
    }
    const profile = this.currentOrg.profiles.find(
      (profile) => profile.profileDescription.id === profileId,
    );
    if (!profile) {
      throw new Error(`Profile ${profileId} not found in current org`);
    }

    const profileKey = await this.getProfileKey(this.currentOrg.id);
    const selectedProfiles =
      this.globalContext.get("lastSelectedProfileForWorkspace") ?? {};
    this.globalContext.update("lastSelectedProfileForWorkspace", {
      ...selectedProfiles,
      [profileKey]: profileId,
    });

    this.currentProfile = profile;
    await this.reloadConfig();
  }

  // Bottom level of cascade: refresh the current profile
  // IMPORTANT - must always refresh when switching profiles
  // Because of e.g. MCP singleton and docs service using things from config
  // Could improve this
  async reloadConfig() {
    if (!this.currentProfile) {
      return {
        config: undefined,
        errors: [],
        configLoadInterrupted: true,
      };
    }

    for (const org of this.organizations) {
      for (const profile of org.profiles) {
        if (
          profile.profileDescription.id !==
          this.currentProfile.profileDescription.id
        ) {
          profile.clearConfig();
        }
      }
    }

    const { config, errors, configLoadInterrupted } =
      await this.currentProfile.reloadConfig(this.additionalContextProviders);

    this.notifyConfigListeners({ config, errors, configLoadInterrupted });
    return { config, errors, configLoadInterrupted };
  }

  // Listeners setup - can listen to current profile updates
  private notifyConfigListeners(result: ConfigResult<ContinueConfig>) {
    for (const listener of this.updateListeners) {
      listener(result);
    }
  }

  private updateListeners: ConfigUpdateFunction[] = [];

  onConfigUpdate(listener: ConfigUpdateFunction) {
    this.updateListeners.push(listener);
  }

  // Methods for loading (without reloading) config
  // Serialized for passing to GUI
  // Load for just awaiting current config load promise for the profile
  async getSerializedConfig(): Promise<
    ConfigResult<BrowserSerializedContinueConfig>
  > {
    if (!this.currentProfile) {
      return {
        config: undefined,
        errors: [],
        configLoadInterrupted: true,
      };
    }
    return await this.currentProfile.getSerializedConfig(
      this.additionalContextProviders,
    );
  }

  /**
   * 현재 프로필의 구성을 로드합니다.
   * @returns
   */
  async loadConfig(): Promise<ConfigResult<ContinueConfig>> {
    if (!this.currentProfile) {
      return {
        config: undefined,
        errors: [],
        configLoadInterrupted: true,
      };
    }
    const config = await this.currentProfile.loadConfig(
      this.additionalContextProviders,
    );

    if (config.errors?.length) {
      logger.warn("Errors loading config: ", config.errors);
    }
    return config;
  }

  /**
   * 주어진 프로필 ID에 대한 구성 프로필을 엽니다.
   * @param profileId - 열 프로필 ID
   * @returns
   */
  async openConfigProfile(profileId?: string) {
    let openProfileId = profileId || this.currentProfile?.profileDescription.id;
    if (!openProfileId) {
      return;
    }
    const profile = this.currentOrg.profiles.find(
      (p) => p.profileDescription.id === openProfileId,
    );
    if (profile?.profileDescription.profileType === "local") {
      await this.ide.openFile(profile.profileDescription.uri);
    } else {
      const env = await getControlPlaneEnv(this.ide.getIdeSettings());
      await this.ide.openUrl(`${env.APP_URL}${openProfileId}`);
    }
  }

  // Ancient method of adding custom providers through vs code
  /**
   * 추가 컨텍스트 제공자를 등록합니다.
   */
  private additionalContextProviders: IContextProvider[] = [];
  registerCustomContextProvider(contextProvider: IContextProvider) {
    this.additionalContextProviders.push(contextProvider);
    void this.reloadConfig();
  }
  /**
   * "submenu" 타입의 추가 컨텍스트 제공자들의 제목을 반환합니다.
   *
   * @returns {string[]} "submenu" 타입의 추가 컨텍스트 제공자들의 제목 배열입니다.
   */
  getAdditionalSubmenuContextProviders(): string[] {
    return this.additionalContextProviders
      .filter((provider) => provider.description.type === "submenu")
      .map((provider) => provider.description.title);
  }
}
