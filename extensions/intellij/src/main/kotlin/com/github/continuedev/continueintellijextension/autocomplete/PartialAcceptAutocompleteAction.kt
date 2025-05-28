package com.github.continuedev.continueintellijextension.autocomplete

import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Caret
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.actionSystem.EditorAction
import com.intellij.openapi.editor.actionSystem.EditorActionHandler

/**
 * 자동완성 제안의 일부만 수락하는 에디터 액션입니다.
 * 사용자가 단축키 등을 통해 자동완성의 일부만 적용할 때 사용됩니다.
 */
class PartialAcceptAutocompleteAction : EditorAction(object : EditorActionHandler() {
    /**
     * 실제로 자동완성 일부를 수락하는 로직을 실행합니다.
     */
    override fun doExecute(editor: Editor, caret: Caret?, dataContext: DataContext?) {
        ApplicationManager.getApplication().runWriteAction {
            // AutocompleteService에서 partialAccept 메서드 호출
            editor.project?.service<AutocompleteService>()?.partialAccept()
        }
    }

    /**
     * 현재 커서 위치에서 이 액션이 활성화될 수 있는지 판단합니다.
     */
    override fun isEnabledForCaret(editor: Editor, caret: Caret, dataContext: DataContext?): Boolean {
        val autocompleteService = editor.project?.service<AutocompleteService>();
        // 자동완성 후보가 현재 에디터와 커서 위치에 있고, 텍스트가 존재할 때만 활성화
        val enabled = editor == autocompleteService?.pendingCompletion?.editor
                && caret.offset == autocompleteService.pendingCompletion?.offset
                && autocompleteService.pendingCompletion?.text != null
        return enabled
    }
})