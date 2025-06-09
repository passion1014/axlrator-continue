import {
  ConfigResult,
  ConfigValidationError,
  FullSlug,
} from "@continuedev/config-yaml";

import {
  BrowserSerializedContinueConfig,
  ContinueConfig,
  IContextProvider,
  IDE,
} from "../index.js";

import { finalToBrowserConfig } from "./load.js";
import { IProfileLoader } from "./profile/IProfileLoader.js";

export interface ProfileDescription {
  fullSlug: FullSlug;
  profileType: "control-plane" | "local" | "platform";
  title: string;
  id: string;
  iconUrl: string;
  errors: ConfigValidationError[] | undefined;
  uri: string;
  rawYaml?: string;
}

export interface OrganizationDescription {
  id: string;
  iconUrl: string;
  name: string;
  slug: string | undefined; // TODO: This doesn't need to be undefined, just doing while transitioning the backend
}

export type OrgWithProfiles = OrganizationDescription & {
  profiles: ProfileLifecycleManager[];
  currentProfile: ProfileLifecycleManager | null;
};

export type SerializedOrgWithProfiles = OrganizationDescription & {
  profiles: ProfileDescription[];
  selectedProfileId: string | null;
};

/**
 * 프로필의 라이프사이클을 관리하며, 설정의 로딩과 저장을 담당합니다.
 */
export class ProfileLifecycleManager {
  private savedConfigResult: ConfigResult<ContinueConfig> | undefined;
  private savedBrowserConfigResult?: ConfigResult<BrowserSerializedContinueConfig>;
  private pendingConfigPromise?: Promise<ConfigResult<ContinueConfig>>;

  constructor(
    private readonly profileLoader: IProfileLoader,
    private readonly ide: IDE,
  ) {}

  get profileDescription(): ProfileDescription {
    return this.profileLoader.description;
  }

  clearConfig() {
    this.savedConfigResult = undefined;
    this.savedBrowserConfigResult = undefined;
    this.pendingConfigPromise = undefined;
  }

  // Clear saved config and reload
  async reloadConfig(
    additionalContextProviders: IContextProvider[] = [],
  ): Promise<ConfigResult<ContinueConfig>> {
    this.savedConfigResult = undefined;
    this.savedBrowserConfigResult = undefined;
    this.pendingConfigPromise = undefined;

    return this.loadConfig(additionalContextProviders, true);
  }

  /**
   * 현재 프로필의 설정을 로드합니다.
   * @param additionalContextProviders 추가 컨텍스트 프로바이더
   * @param forceReload 강제 리로드 여부
   * @returns 설정 결과
   */
  async loadConfig(
    additionalContextProviders: IContextProvider[],
    forceReload: boolean = false,
  ): Promise<ConfigResult<ContinueConfig>> {
    // If we already have a config, return it
    if (!forceReload) {
      if (this.savedConfigResult) {
        return this.savedConfigResult;
      } else if (this.pendingConfigPromise) {
        return this.pendingConfigPromise;
      }
    }

    // Set pending config promise
    this.pendingConfigPromise = new Promise(async (resolve, reject) => {
      let result: ConfigResult<ContinueConfig>;
      // This try catch is expected to catch high-level errors that aren't block-specific
      // Like invalid json, invalid yaml, file read errors, etc.
      // NOT block-specific loading errors
      try {
        result = await this.profileLoader.doLoadConfig();
      } catch (e) {
        const message =
          e instanceof Error
            ? `${e.message}\n${e.stack ? e.stack : ""}`
            : "Error loading config";
        result = {
          errors: [
            {
              fatal: true,
              message,
            },
          ],
          config: undefined,
          configLoadInterrupted: true,
        };
      }

      if (result.config) {
        // Add registered context providers
        result.config.contextProviders = (
          result.config.contextProviders ?? []
        ).concat(additionalContextProviders);
      }

      resolve(result);
    });

    // Wait for the config promise to resolve
    this.savedConfigResult = await this.pendingConfigPromise;
    this.pendingConfigPromise = undefined;
    return this.savedConfigResult;
  }

  /**
   * 현재 프로필의 직렬화된 설정을 반환합니다.
   * 이미 설정이 로드된 경우, 캐시된 결과를 반환합니다.
   * @param additionalContextProviders 추가 컨텍스트 프로바이더
   * @returns 직렬화된 설정 결과
   */
  async getSerializedConfig(
    additionalContextProviders: IContextProvider[],
  ): Promise<ConfigResult<BrowserSerializedContinueConfig>> {
    if (this.savedBrowserConfigResult) {
      return this.savedBrowserConfigResult;
    } else {
      const result = await this.loadConfig(additionalContextProviders);
      if (!result.config) {
        return {
          ...result,
          config: undefined,
        };
      }
      const serializedConfig = await finalToBrowserConfig(
        result.config,
        this.ide,
      );
      return {
        ...result,
        config: serializedConfig,
      };
    }
  }
}
