package com.github.continuedev.continueintellijextension.editor

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.project.DumbAware

/**
 * 인라인 편집 액션 클래스.
 * 에디터에서 인라인 편집 UI를 여는 역할을 한다.
 */
class InlineEditAction : AnAction(), DumbAware {
    /**
     * 액션의 활성화 및 표시 여부를 갱신한다.
     */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = true
        e.presentation.isVisible = true
    }

    /**
     * 액션 업데이트 스레드를 지정한다.
     * EDT(이벤트 디스패치 스레드)에서 동작하도록 설정.
     */
    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.EDT
    }

    /**
     * 액션이 실행될 때 호출된다.
     * 현재 에디터와 프로젝트를 가져와 인라인 편집을 연다.
     */
    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(PlatformDataKeys.EDITOR) ?: return
        val project = e.getData(PlatformDataKeys.PROJECT) ?: return
        openInlineEdit(project, editor)
    }
}