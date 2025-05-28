package com.github.continuedev.continueintellijextension.listeners

import ToolTipComponent
import com.github.continuedev.continueintellijextension.editor.EditorUtils
import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.github.continuedev.continueintellijextension.utils.Debouncer
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.SelectionModel
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.util.TextRange
import kotlinx.coroutines.CoroutineScope
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.ex.util.EditorUtil
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditor

/**
 * 에디터에서 선택 영역이 변경될 때 툴팁을 표시하거나 제거하는 리스너입니다.
 *
 * - 선택 영역이 변경되면 debounce 후 handleSelection을 호출합니다.
 * - 파일 에디터가 아닐 경우, 또는 선택 영역이 없거나 설정에 따라 툴팁을 제거합니다.
 * - 전체 파일 선택 시 에디터를 스크롤하여 툴팁이 보이도록 합니다.
 * - 선택 영역의 위치와 내용에 따라 툴팁의 위치를 계산하여 표시합니다.
 */
class ContinuePluginSelectionListener(
    coroutineScope: CoroutineScope,
) : SelectionListener, DumbAware {
    /**
     * 선택 이벤트 처리 디바운서
     */
    private val debouncer = Debouncer(100, coroutineScope)
    private var toolTipComponents: ArrayList<ToolTipComponent> = ArrayList()
    private var lastActiveEditor: Editor? = null

    /**
     * 선택 영역이 변경될 때 호출됩니다.
     */
    override fun selectionChanged(e: SelectionEvent) {
        if (e.editor.isDisposed || e.editor.project?.isDisposed == true) {
            return
        }

        debouncer.debounce { handleSelection(e) }
    }

    /**
     * 모든 툴팁을 제거합니다.
     */
    private fun removeAllTooltips() {
        ApplicationManager.getApplication().invokeLater {
            toolTipComponents.forEach { tooltip ->
                tooltip.parent?.remove(tooltip)
            }
            toolTipComponents.clear()
        }
    }

    /**
     * 선택 이벤트를 처리합니다.
     */
    private fun handleSelection(e: SelectionEvent) {
        ApplicationManager.getApplication().invokeLater {
            val editor = e.editor

            if (!isFileEditor(editor)) {
                removeAllTooltips()
                return@invokeLater
            }

            // 파일이 바뀌면 기존 툴팁 제거
            if (editor != lastActiveEditor) {
                removeAllTooltips()
                lastActiveEditor = editor
            }

            val model: SelectionModel = editor.selectionModel
            val selectedText = model.selectedText

            if (shouldRemoveTooltip(selectedText, editor)) {
                removeExistingTooltips(editor)
                return@invokeLater
            }

            updateTooltip(editor, model)
        }
    }

    /**
     * 에디터가 파일 에디터인지 확인합니다.
     */
    private fun isFileEditor(editor: Editor): Boolean {
        val project = editor.project ?: return false
        val virtualFile = FileDocumentManager.getInstance().getFile(editor.document)

        // 파일이 존재하고 로컬 파일 시스템에 있는지 확인
        if (virtualFile == null || !virtualFile.isInLocalFileSystem) {
            return false
        }

        // 콘솔이 아닌지 확인
        val fileEditorManager = FileEditorManager.getInstance(project)
        val fileEditor = fileEditorManager.getSelectedEditor(virtualFile)

        return fileEditor is TextEditor
    }

    /**
     * 툴팁을 제거해야 하는지 여부를 반환합니다.
     */
    private fun shouldRemoveTooltip(selectedText: String?, editor: Editor): Boolean {
        return selectedText.isNullOrEmpty() ||
                !service<ContinueExtensionSettings>().continueState.displayEditorTooltip
    }

    /**
     * 기존 툴팁을 제거합니다.
     */
    private fun removeExistingTooltips(editor: Editor, onComplete: () -> Unit = {}) {
        ApplicationManager.getApplication().invokeLater {
            toolTipComponents.forEach {
                editor.contentComponent.remove(it)
            }
            editor.contentComponent.revalidate()
            editor.contentComponent.repaint()
            toolTipComponents.clear()
            onComplete()
        }
    }

    /**
     * 툴팁을 갱신합니다.
     */
    private fun updateTooltip(editor: Editor, model: SelectionModel) {
        removeExistingTooltips(editor) {
            ApplicationManager.getApplication().invokeLater {
                val document = editor.document
                val (startLine, endLine, isFullLineSelection) = getSelectionInfo(model, document)

                // 전체 파일이 선택된 경우
                val isEntireFileSelected = model.selectionStart == 0 &&
                        model.selectionEnd == document.textLength

                // 전체 파일 선택 시 스크롤을 맨 위로 이동
                if (isEntireFileSelected) {
                    editor.scrollingModel.scrollTo(
                        LogicalPosition(0, 0),
                        com.intellij.openapi.editor.ScrollType.CENTER
                    )
                }

                val selectionTopY = calculateSelectionTopY(editor, startLine, endLine, isFullLineSelection)
                val tooltipX = calculateTooltipX(editor, document, startLine, endLine, isFullLineSelection)

                if (tooltipX != null) {
                    addToolTipComponent(editor, tooltipX, selectionTopY)
                }
            }
        }
    }

    /**
     * 선택 영역의 시작/끝 라인 및 전체 라인 선택 여부를 반환합니다.
     */
    private fun getSelectionInfo(model: SelectionModel, document: Document): Triple<Int, Int, Boolean> {
        val startOffset = model.selectionStart
        val endOffset = model.selectionEnd
        val startLine = document.getLineNumber(startOffset)
        val endLine = document.getLineNumber(endOffset)
        val isFullLineSelection = startOffset == document.getLineStartOffset(startLine) &&
                ((endLine > 0 && endOffset == document.getLineEndOffset(endLine - 1)) || endOffset == document.getLineStartOffset(
                    endLine
                ))

        val adjustedEndLine = if (isFullLineSelection && endLine > startLine) endLine - 1 else endLine

        return Triple(startLine, adjustedEndLine, isFullLineSelection)
    }

    /**
     * 선택 영역의 Y 좌표(상단)를 계산합니다.
     */
    private fun calculateSelectionTopY(
        editor: Editor,
        startLine: Int,
        endLine: Int,
        isFullLineSelection: Boolean
    ): Int {
        return if (startLine == endLine || isFullLineSelection) {
            val lineTopY = editor.logicalPositionToXY(LogicalPosition(startLine, 0)).y
            lineTopY + (editor.lineHeight / 2)
        } else {
            editor.logicalPositionToXY(LogicalPosition(startLine, 0)).y
        }
    }

    /**
     * 툴팁의 X 좌표를 계산합니다.
     */
    private fun calculateTooltipX(
        editor: Editor,
        document: Document,
        startLine: Int,
        endLine: Int,
        isFullLineSelection: Boolean
    ): Int? {
        fun isLineEmpty(lineNumber: Int): Boolean {
            val lineStartOffset = document.getLineStartOffset(lineNumber)
            val lineEndOffset = document.getLineEndOffset(lineNumber)
            return document.getText(TextRange(lineStartOffset, lineEndOffset)).trim().isEmpty()
        }

        fun getLineEndX(lineNumber: Int): Int {
            val lineStartOffset = document.getLineStartOffset(lineNumber)
            val lineEndOffset = document.getLineEndOffset(lineNumber)
            val lineText = document.getText(TextRange(lineStartOffset, lineEndOffset)).trimEnd()
            val visualPosition = editor.offsetToVisualPosition(lineStartOffset + lineText.length)
            return editor.visualPositionToXY(visualPosition).x
        }

        val offset = 40

        // 한 줄만 선택되고 그 줄이 비어있으면 null 반환
        if (startLine == endLine && isLineEmpty(startLine) && !isFullLineSelection) {
            return null
        }

        // 선택 영역 내에서 가장 위에 있는 비어있지 않은 라인 찾기
        var topNonEmptyLine = startLine
        while (topNonEmptyLine <= endLine && isLineEmpty(topNonEmptyLine)) {
            topNonEmptyLine++
        }

        // 선택 영역이 모두 비어있으면 null 반환
        if (topNonEmptyLine > endLine) {
            return null
        }

        // 한 줄 선택 또는 전체 라인 선택 시
        if (isFullLineSelection || startLine == endLine) {
            return getLineEndX(topNonEmptyLine) + offset
        }

        // 선택 영역 위의 라인 좌표 계산
        val lineAboveSelection = maxOf(0, startLine - 1)

        // x 좌표 계산
        val xCoordTopNonEmpty = getLineEndX(topNonEmptyLine)
        val xCoordLineAbove = getLineEndX(lineAboveSelection)

        // 두 좌표 중 큰 값 사용
        val baseXCoord = maxOf(xCoordTopNonEmpty, xCoordLineAbove)

        // 최종 x 좌표 반환
        return baseXCoord + offset
    }

    /**
     * 툴팁 컴포넌트를 에디터에 추가합니다.
     */
    private fun addToolTipComponent(editor: Editor, tooltipX: Int, selectionTopY: Int) {
        val toolTipComponent = ToolTipComponent(editor, tooltipX, selectionTopY)
        toolTipComponents.add(toolTipComponent)
        editor.contentComponent.add(toolTipComponent)
        editor.contentComponent.revalidate()
        editor.contentComponent.repaint()
    }
}


