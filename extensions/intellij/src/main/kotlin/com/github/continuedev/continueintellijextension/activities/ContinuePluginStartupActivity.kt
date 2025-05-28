package com.github.continuedev.continueintellijextension.activities

import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.github.continuedev.continueintellijextension.auth.AuthListener
import com.github.continuedev.continueintellijextension.auth.ContinueAuthService
import com.github.continuedev.continueintellijextension.auth.ControlPlaneSessionInfo
import com.github.continuedev.continueintellijextension.constants.getContinueGlobalPath
import com.github.continuedev.continueintellijextension.`continue`.*
import com.github.continuedev.continueintellijextension.listeners.ContinuePluginSelectionListener
import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.github.continuedev.continueintellijextension.services.SettingsListener
import com.github.continuedev.continueintellijextension.utils.toUriOrNull
import com.intellij.openapi.actionSystem.KeyboardShortcut
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.components.ServiceManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.keymap.KeymapManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import com.intellij.openapi.util.io.StreamUtil
import com.intellij.openapi.vfs.LocalFileSystem
import kotlinx.coroutines.*
import java.io.*
import java.nio.charset.StandardCharsets
import java.nio.file.Paths
import javax.swing.*
import com.intellij.openapi.components.service
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.vfs.VirtualFile

fun showTutorial(project: Project) {
    val tutorialFileName = getTutorialFileName()

    ContinuePluginStartupActivity::class.java.getClassLoader().getResourceAsStream(tutorialFileName)
        .use { `is` ->
            if (`is` == null) {
                throw IOException("Resource not found: $tutorialFileName")
            }
            var content = StreamUtil.readText(`is`, StandardCharsets.UTF_8)

            // All jetbrains will use J instead of L
            content = content.replace("[Cmd + L]", "[Cmd + J]")
            content = content.replace("[Cmd + Shift + L]", "[Cmd + Shift + J]")

            if (!System.getProperty("os.name").lowercase().contains("mac")) {
                content = content.replace("[Cmd + J]", "[Ctrl + J]")
                content = content.replace("[Cmd + Shift + J]", "[Ctrl + Shift + J]")
                content = content.replace("[Cmd + I]", "[Ctrl + I]")
                content = content.replace("⌘", "⌃")
            }
            val filepath = Paths.get(getContinueGlobalPath(), tutorialFileName).toString()
            File(filepath).writeText(content)
            val virtualFile = LocalFileSystem.getInstance().findFileByPath(filepath)

            ApplicationManager.getApplication().invokeLater {
                if (virtualFile != null) {
                    FileEditorManager.getInstance(project).openFile(virtualFile, true)
                }
            }
        }
}

private fun getTutorialFileName(): String {
    val appName = ApplicationNamesInfo.getInstance().fullProductName.lowercase()
    return when {
        appName.contains("intellij") -> "continue_tutorial.java"
        appName.contains("pycharm") -> "continue_tutorial.py"
        appName.contains("webstorm") -> "continue_tutorial.ts"
        else -> "continue_tutorial.py" // Default to Python tutorial
    }
}

// 플러그인 시작 시 실행되는 StartupActivity 구현체
class ContinuePluginStartupActivity : StartupActivity, DumbAware {

    // 플러그인 시작 시 호출되는 메서드
    override fun runActivity(project: Project) {
        // 단축키 충돌 방지: 기존 단축키 제거
        removeShortcutFromAction(getPlatformSpecificKeyStroke("J"))
        removeShortcutFromAction(getPlatformSpecificKeyStroke("shift J"))
        removeShortcutFromAction(getPlatformSpecificKeyStroke("I"))
        // 플러그인 초기화
        initializePlugin(project)
    }

    // OS에 따라 플랫폼별 단축키 문자열 반환
    private fun getPlatformSpecificKeyStroke(key: String): String {
        val osName = System.getProperty("os.name").toLowerCase()
        val modifier = if (osName.contains("mac")) "meta" else "control"
        return "$modifier $key"
    }

    // 지정한 단축키가 Continue 액션에 할당되어 있지 않으면 해당 단축키를 제거
    private fun removeShortcutFromAction(shortcut: String) {
        val keymap = KeymapManager.getInstance().activeKeymap
        val keyStroke = KeyStroke.getKeyStroke(shortcut)
        val actionIds = keymap.getActionIds(keyStroke)

        // Continue로 시작하는 액션이 아니면 제거하지 않음
        if (!actionIds.any { it.startsWith("continue") }) {
            return
        }

        for (actionId in actionIds) {
            if (actionId.startsWith("continue")) {
                continue
            }
            val shortcuts = keymap.getShortcuts(actionId)
            for (shortcut in shortcuts) {
                if (shortcut is KeyboardShortcut && shortcut.firstKeyStroke == keyStroke) {
                    keymap.removeShortcut(actionId, shortcut)
                }
            }
        }
    }

    // 플러그인 초기화 로직
    private fun initializePlugin(project: Project) {
        val coroutineScope = CoroutineScope(Dispatchers.IO)
        val continuePluginService = ServiceManager.getService(
            project,
            ContinuePluginService::class.java
        )

        coroutineScope.launch {
            // 설정 서비스 가져오기
            val settings =
                ServiceManager.getService(ContinueExtensionSettings::class.java)
            // 웰컴 다이얼로그가 표시되지 않았다면 튜토리얼 파일 오픈
            if (!settings.continueState.shownWelcomeDialog) {
                settings.continueState.shownWelcomeDialog = true
                showTutorial(project)
            }

            // 원격 동기화 작업 추가
            settings.addRemoteSyncJob()

            // IDE 프로토콜 클라이언트 및 Diff 매니저 생성
            val ideProtocolClient = IdeProtocolClient(
                continuePluginService,
                coroutineScope,
                project
            )

            val diffManager = DiffManager(project)

            continuePluginService.diffManager = diffManager
            continuePluginService.ideProtocolClient = ideProtocolClient

            // 설정 변경 리스너 등록
            val connection = ApplicationManager.getApplication().messageBus.connect()
            connection.subscribe(SettingsListener.TOPIC, object : SettingsListener {
                override fun settingsUpdated(settings: ContinueExtensionSettings.ContinueState) {
                    continuePluginService.coreMessenger?.request(
                        "config/ideSettingsUpdate", mapOf(
                            "remoteConfigServerUrl" to settings.remoteConfigServerUrl,
                            "remoteConfigSyncPeriod" to settings.remoteConfigSyncPeriod,
                            "userToken" to settings.userToken,
                        ), null
                    ) { _ -> }
                }
            })

            // 파일 시스템 변경 리스너 등록 (삭제, 변경, 생성)
            connection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
                override fun after(events: List<VFileEvent>) {
                    // 삭제된 파일 URI 수집 및 전송
                    val deletedURIs = events.filterIsInstance<VFileDeleteEvent>()
                        .mapNotNull { event -> event.file.toUriOrNull() }

                    if (deletedURIs.isNotEmpty()) {
                        val data = mapOf("uris" to deletedURIs)
                        continuePluginService.coreMessenger?.request("files/deleted", data, null) { _ -> }
                    }

                    // 변경된 파일 URI 수집 및 전송
                    val changedURIs = events.filterIsInstance<VFileContentChangeEvent>()
                        .mapNotNull { event -> event.file.toUriOrNull() }

                    if (changedURIs.isNotEmpty()) {
                        continuePluginService.updateLastFileSaveTimestamp()

                        val data = mapOf("uris" to changedURIs)
                        continuePluginService.coreMessenger?.request("files/changed", data, null) { _ -> }
                    }

                    // 생성된 파일 URI 수집 및 전송
                    events.filterIsInstance<VFileCreateEvent>()
                        .mapNotNull { event -> event.file?.toUriOrNull() }
                        .takeIf { it.isNotEmpty() }?.let {
                            val data = mapOf("uris" to it)
                            continuePluginService.coreMessenger?.request("files/created", data, null) { _ -> }
                        }

                    // TODO: 파일 복사, 이름 변경 등 추가 처리 필요
                }
            })

            // 파일 에디터 열기/닫기 리스너 등록
            connection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
                override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                    file.toUriOrNull()?.let { uri ->
                        val data = mapOf("uris" to listOf(uri))
                        continuePluginService.coreMessenger?.request("files/closed", data, null) { _ -> }
                    }
                }

                override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
                    file.toUriOrNull()?.let { uri ->
                        val data = mapOf("uris" to listOf(uri))
                        continuePluginService.coreMessenger?.request("files/opened", data, null) { _ -> }
                    }
                }
            })

            // 테마 변경 리스너 등록
            connection.subscribe(LafManagerListener.TOPIC, LafManagerListener {
                val colors = GetTheme().getTheme();
                continuePluginService.sendToWebview(
                    "jetbrains/setColors",
                    colors
                )
            })

            // 인증 서비스 및 세션 정보 로드
            val authService = service<ContinueAuthService>()
            val initialSessionInfo = authService.loadControlPlaneSessionInfo()

            // 세션 정보가 있으면 core에 전달
            if (initialSessionInfo != null) {
                val data = mapOf(
                    "sessionInfo" to initialSessionInfo
                )
                continuePluginService.coreMessenger?.request("didChangeControlPlaneSessionInfo", data, null) { _ -> }
            }

            // 인증 관련 리스너 등록
            connection.subscribe(AuthListener.TOPIC, object : AuthListener {
                override fun startAuthFlow() {
                    authService.startAuthFlow(project, false)
                }

                override fun handleUpdatedSessionInfo(sessionInfo: ControlPlaneSessionInfo?) {
                    val data = mapOf(
                        "sessionInfo" to sessionInfo
                    )
                    continuePluginService.coreMessenger?.request(
                        "didChangeControlPlaneSessionInfo",
                        data,
                        null
                    ) { _ -> }
                }
            })

            // 선택 리스너 등록
            val listener =
                ContinuePluginSelectionListener(
                    coroutineScope,
                )

            // 워크스페이스 경로 설정 (최상위 모듈만)
            continuePluginService?.let { pluginService ->
                val allModulePaths = ModuleManager.getInstance(project).modules
                    .flatMap { module -> ModuleRootManager.getInstance(module).contentRoots.mapNotNull { it.toUriOrNull() } }

                val topLevelModulePaths = allModulePaths
                    .filter { modulePath -> allModulePaths.none { it != modulePath && modulePath.startsWith(it) } }

                pluginService.workspacePaths = topLevelModulePaths.toTypedArray()
            }

            // 에디터 선택 리스너 등록
            EditorFactory.getInstance().eventMulticaster.addSelectionListener(
                listener,
                ContinuePluginDisposable.getInstance(project)
            )

            // CoreMessengerManager 등록
            val coreMessengerManager = CoreMessengerManager(project, ideProtocolClient, coroutineScope)
            continuePluginService.coreMessengerManager = coreMessengerManager
        }
    }

}