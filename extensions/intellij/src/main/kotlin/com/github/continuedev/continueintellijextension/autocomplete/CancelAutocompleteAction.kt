package com.github.continuedev.continueintellijextension.autocomplete

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project

/**
 * 에디터에서 자동완성 후보를 취소하는 액션입니다.
 * 사용자가 에디터에서 이 액션을 실행하면, 현재 에디터의 자동완성 후보 및 인레이가 모두 제거됩니다.
 */
class CancelAutocompleteAction : AnAction() {

    /**
     * 액션이 실행될 때 호출됩니다.
     * 에디터에서 호출된 경우, AutocompleteService를 통해 자동완성 후보를 제거합니다.
     */
    override fun actionPerformed(e: AnActionEvent) {
        if (isInvokedInEditor(e)) {
            val editor = e.getRequiredData(CommonDataKeys.EDITOR)
            ApplicationManager.getApplication().runWriteAction {
                editor.project?.service<AutocompleteService>()?.clearCompletions(editor)
            }
        }
    }

    /**
     * 액션의 활성화/표시 여부를 갱신합니다.
     * 에디터에서만 활성화됩니다.
     */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = isInvokedInEditor(e)
    }

    /**
     * 액션이 에디터에서 호출되었는지 확인합니다.
     */
    private fun isInvokedInEditor(e: AnActionEvent): Boolean {
        val project: Project? = e.project
        val editor: Editor? = e.getData(CommonDataKeys.EDITOR)
        return project != null && editor != null && editor.contentComponent.hasFocus()
    }

    /**
     * 액션 업데이트 스레드를 지정합니다.
     * 백그라운드 스레드에서 업데이트됩니다.
     */
    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.BGT
    }
}
