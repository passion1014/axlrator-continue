package com.github.continuedev.continueintellijextension.actions

import com.github.continuedev.continueintellijextension.editor.DiffStreamService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager


// Diff를 수락하는 액션 클래스
class AcceptDiffAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        acceptHorizontalDiff(e) // 수평 Diff 수락
        acceptVerticalDiff(e)   // 수직 Diff 수락
    }

    // 수평 Diff를 수락하는 메서드
    private fun acceptHorizontalDiff(e: AnActionEvent) {
        val continuePluginService = getPluginService(e.project) ?: return
        continuePluginService.diffManager?.acceptDiff(null)
    }

    // 수직 Diff를 수락하는 메서드
    private fun acceptVerticalDiff(e: AnActionEvent) {
        val project = e.project ?: return
        val editor =
            e.getData(PlatformDataKeys.EDITOR) ?: FileEditorManager.getInstance(project).selectedTextEditor ?: return
        val diffStreamService = project.service<DiffStreamService>()
        diffStreamService.accept(editor)
    }
}

// Diff를 거부하는 액션 클래스
class RejectDiffAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        rejectHorizontalDiff(e) // 수평 Diff 거부
        rejectVerticalDiff(e)   // 수직 Diff 거부
    }

    // 수평 Diff를 거부하는 메서드
    private fun rejectHorizontalDiff(e: AnActionEvent) {
        val continuePluginService = getPluginService(e.project) ?: return
        continuePluginService.diffManager?.rejectDiff(null)
    }

    // 수직 Diff를 거부하는 메서드
    private fun rejectVerticalDiff(e: AnActionEvent) {
        val project = e.project ?: return
        val editor =
            e.getData(PlatformDataKeys.EDITOR) ?: FileEditorManager.getInstance(project).selectedTextEditor ?: return
        val diffStreamService = project.service<DiffStreamService>()
        diffStreamService.reject(editor)
    }
}


// 선택된 코드를 컨텍스트에 추가(입력창 포커스, 채팅 초기화 없이)
class FocusContinueInputWithoutClearAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        focusContinueInput(project)
    }
}

// 선택된 코드를 컨텍스트에 추가(입력창 포커스, 채팅 초기화)
class FocusContinueInputAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val continuePluginService = getContinuePluginService(e.project) ?: return

        continuePluginService.continuePluginWindow?.content?.components?.get(0)?.requestFocus()
        continuePluginService.sendToWebview("focusContinueInputWithNewSession", null)

        continuePluginService.ideProtocolClient?.sendHighlightedCode()
    }
}

// 새로운 세션을 시작하는 액션 클래스
class NewContinueSessionAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val continuePluginService = getContinuePluginService(e.project) ?: return
        continuePluginService.continuePluginWindow?.content?.components?.get(0)?.requestFocus()
        continuePluginService.sendToWebview("focusContinueInputWithNewSession", null)
    }
}

// 히스토리 뷰로 이동하는 액션 클래스
class ViewHistoryAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val continuePluginService = getContinuePluginService(e.project) ?: return
        val params = mapOf("path" to "/history", "toggle" to true)
        continuePluginService.sendToWebview("navigateTo", params)
    }
}

// 설정 페이지로 이동하는 액션 클래스
class OpenConfigAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val continuePluginService = getContinuePluginService(e.project) ?: return
        continuePluginService.continuePluginWindow?.content?.components?.get(0)?.requestFocus()
        val params = mapOf("path" to "/config", "toggle" to true)
        continuePluginService.sendToWebview("navigateTo", params)
    }
}

// 로그 파일을 여는 액션 클래스
class OpenLogsAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val logFile = java.io.File(System.getProperty("user.home") + "/.continue/logs/core.log")
        if (logFile.exists()) {
            val virtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByIoFile(logFile)
            if (virtualFile != null) {
                FileEditorManager.getInstance(project).openFile(virtualFile, true)
            }
        }
    }
}



