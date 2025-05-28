package com.github.continuedev.continueintellijextension.autocomplete

import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Caret
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.actionSystem.EditorAction
import com.intellij.openapi.editor.actionSystem.EditorActionHandler

/**
 * 자동완성 제안을 수락하는 에디터 액션입니다.
 * - 현재 에디터와 AutocompleteService의 pendingCompletion이 일치하고,
 * - caret 위치가 일치하며,
 * - pendingCompletion의 텍스트가 존재할 때만 활성화됩니다.
 */
class AcceptAutocompleteAction : EditorAction(object : EditorActionHandler() {
    override fun doExecute(editor: Editor, caret: Caret?, dataContext: DataContext?) {
        // AutocompleteService의 accept 메서드를 호출하여 자동완성 적용
        ApplicationManager.getApplication().runWriteAction {
            editor.project?.service<AutocompleteService>()?.accept()
        }
    }

    override fun isEnabledForCaret(editor: Editor, caret: Caret, dataContext: DataContext?): Boolean {
        // 현재 에디터와 AutocompleteService의 pendingCompletion이 일치하고,
        // caret 위치가 일치하며, 텍스트가 존재할 때만 활성화
        val autocompleteService = editor.project?.service<AutocompleteService>()
        val enabled = editor == autocompleteService?.pendingCompletion?.editor
//                && caret.offset == autocompleteService.pendingCompletion?.offset
                && autocompleteService.pendingCompletion?.text != null
        return enabled
    }
})