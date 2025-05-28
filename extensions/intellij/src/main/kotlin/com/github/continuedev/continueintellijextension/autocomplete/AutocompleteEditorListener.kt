package com.github.continuedev.continueintellijextension.autocomplete

import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorKind
import com.intellij.openapi.editor.event.*
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.util.TextRange

/**
 * 에디터의 Caret(커서) 위치 변경을 감지하여 자동완성 상태를 관리하는 리스너입니다.
 * - 메인 에디터에서만 동작합니다.
 * - 마지막 변경이 부분 수락(partial accept)이었다면 플래그를 초기화하고 종료합니다.
 * - 현재 pendingCompletion이 있고, 에디터와 오프셋이 일치하면 아무 작업도 하지 않습니다.
 * - 그 외에는 자동완성 후보를 모두 제거합니다.
 */
class AutocompleteCaretListener : CaretListener {
    override fun caretPositionChanged(event: CaretEvent) {
        if(event.editor.editorKind != EditorKind.MAIN_EDITOR) {
            return
        }

        val caret = event.caret ?: return
        val offset = caret.offset
        val editor = caret.editor
        val autocompleteService = editor.project?.service<AutocompleteService>() ?: return

        if (autocompleteService.lastChangeWasPartialAccept) {
            autocompleteService.lastChangeWasPartialAccept = false
            return
        }

        val pending = autocompleteService.pendingCompletion;
        if (pending != null && pending.editor == editor && pending.offset == offset) {
            return
        }
        autocompleteService.clearCompletions(editor)
    }
}

/**
 * 에디터의 Document(문서) 변경을 감지하여 자동완성 트리거를 관리하는 리스너입니다.
 * - 현재 에디터가 선택된 에디터일 때만 동작합니다.
 * - 마지막 변경이 부분 수락(partial accept)이었다면 아무 작업도 하지 않습니다.
 * - 변경 후 invokeLater로 자동완성 트리거를 호출합니다(동기화 문제 방지).
 */
class AutocompleteDocumentListener(private val editorManager: FileEditorManager, private val editor: Editor) :
    DocumentListener {
    override fun documentChanged(event: DocumentEvent) {
        if (editor != editorManager.selectedTextEditor) {
            return
        }

        val service = editor.project?.service<AutocompleteService>() ?: return
        if (service.lastChangeWasPartialAccept) {
            return
        }

        // Invoke later는 문서가 업데이트되기 전에 자동완성이 트리거되는 문제를 방지합니다.
        // TODO: concurrency
        invokeLater {
            service.triggerCompletion(editor)
        }
    }
}

/**
 * 에디터 생성/해제 시 자동완성 관련 리스너를 등록/해제하는 EditorFactoryListener 구현체입니다.
 * - 에디터 생성 시 CaretListener, DocumentListener, FileEditorManagerListener를 등록합니다.
 * - 에디터 해제 시 등록된 리스너를 모두 해제합니다.
 */
class AutocompleteEditorListener : EditorFactoryListener {
    private val disposables = mutableMapOf<Editor, () -> Unit>()
    override fun editorCreated(event: EditorFactoryEvent) {
        val editor = event.editor
        val project = editor.project ?: return
        val editorManager = project.let { FileEditorManager.getInstance(it) } ?: return
        val completionProvider = project.service<AutocompleteService>()

        // Caret 위치 변경 리스너 등록
        val caretListener = AutocompleteCaretListener()
        editor.caretModel.addCaretListener(caretListener)

        // 에디터 선택 변경 리스너 등록
        val connection = editor.project?.messageBus?.connect()
        connection?.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun selectionChanged(event: FileEditorManagerEvent) {
                completionProvider.clearCompletions(editor)
            }
        })

        // 문서 변경 리스너 등록
        val documentListener = AutocompleteDocumentListener(editorManager, editor)
        editor.document.addDocumentListener(documentListener)

        // 해제용 disposable 등록
        disposables[editor] = {
            editor.caretModel.removeCaretListener(caretListener)
            connection?.disconnect()
            editor.document.removeDocumentListener(documentListener)
        }
    }

    override fun editorReleased(event: EditorFactoryEvent) {
        val editor = event.editor
        val disposable = disposables[editor]
        disposable?.invoke()
        disposables.remove(editor)
    }
}