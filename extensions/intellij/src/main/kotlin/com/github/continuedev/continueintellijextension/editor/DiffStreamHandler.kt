package com.github.continuedev.continueintellijextension.editor

import com.github.continuedev.continueintellijextension.ApplyState
import com.github.continuedev.continueintellijextension.ApplyStateStatus
import com.github.continuedev.continueintellijextension.StreamDiffLinesPayload
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.components.ServiceManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import kotlin.math.max
import kotlin.math.min


enum class DiffLineType {
    SAME, NEW, OLD
}

/**
 * DiffStreamHandler는 에디터에서 diff 스트림을 처리하고, diff 블록을 관리하며,
 * diff 라인에 따라 에디터의 하이라이트, diff 블록 생성/수정/삭제, 상태 업데이트 등을 담당합니다.
 *
 * 주요 기능:
 * - diff 라인 타입(SAME, NEW, OLD)에 따라 에디터에 diff를 실시간으로 반영
 * - diff 블록의 수락/거부 처리 및 위치 업데이트
 * - diff 스트림의 상태를 외부(웹뷰 등)에 전송
 * - 에디터의 하이라이트 및 UI 요소 관리
 * - diff 스트림의 완료 및 취소 처리
 */
class DiffStreamHandler(
    private val project: Project,
    private val editor: Editor,
    private val startLine: Int,
    private val endLine: Int,
    private val onClose: () -> Unit,
    private val onFinish: () -> Unit,
    private val streamId: String?,
    private val toolCallId: String?
) {
    /**
     * 현재 라인 상태를 나타내는 데이터 클래스
     */
    private data class CurLineState(
        var index: Int, var highlighter: RangeHighlighter? = null, var diffBlock: VerticalDiffBlock? = null
    )

    private val diffBlocks: MutableList<VerticalDiffBlock> = mutableListOf()
    private var curLine = CurLineState(startLine)
    private var isRunning: Boolean = false
    private var hasAcceptedOrRejectedBlock: Boolean = false
    private val unfinishedHighlighters: MutableList<RangeHighlighter> = mutableListOf()
    private val continuePluginService = ServiceManager.getService(project, ContinuePluginService::class.java)
    private val virtualFile = FileDocumentManager.getInstance().getFile(editor.document)

    init {
        // 미완성 라인 하이라이트 초기화
        initUnfinishedRangeHighlights()
    }

    /**
     * diff 상태를 외부(웹뷰 등)에 전송
     */
    private fun sendUpdate(status: ApplyStateStatus) {
        if (streamId == null) {
            return
        }

        // Define a single payload and use it for sending
        val payload = ApplyState(
            streamId = streamId,
            status = status.status,
            numDiffs = diffBlocks.size,
            filepath = virtualFile?.url,
            fileContent = "not implemented",
            toolCallId = toolCallId?.toString()
        )

        continuePluginService.sendToWebview("updateApplyState", payload)
    }

    /**
     * 모든 diff 블록을 수락
     */
    fun acceptAll() {
        ApplicationManager.getApplication().invokeLater {
            diffBlocks.toList().forEach { it.handleAccept() }
        }
    }

    /**
     * 모든 diff 블록을 거부 또는 변경사항 전체 undo
     */
    fun rejectAll() {
        // The ideal action here is to undo all changes we made to return the user's edit buffer to the state prior
        // to our changes. However, if the user has accepted or rejected one or more diff blocks, there isn't a simple
        // way to undo our changes without also undoing the diff that the user accepted or rejected.
        if (hasAcceptedOrRejectedBlock) {
            ApplicationManager.getApplication().invokeLater {
                val blocksToReject = diffBlocks.toList()
                blocksToReject.toList().forEach { it.handleReject() }
            }
        } else {
            undoChanges()
            // We have to manually call `handleClosedState`, but above,
            // this is done by invoking the button handlers
            setClosed()
        }
    }

    /**
     * diff 라인 스트림을 에디터에 반영
     */
    fun streamDiffLinesToEditor(
        input: String,
        prefix: String,
        highlighted: String,
        suffix: String,
        modelTitle: String,
        includeRulesInSystemMessage: Boolean
    ) {
        isRunning = true
        sendUpdate(ApplyStateStatus.STREAMING)

        continuePluginService.coreMessenger?.request(
            "streamDiffLines",
            StreamDiffLinesPayload(
                input = input,
                prefix = prefix,
                highlighted = highlighted,
                suffix = suffix,
                language = virtualFile?.fileType?.name,
                modelTitle = modelTitle,
                includeRulesInSystemMessage = includeRulesInSystemMessage,
                fileUri = virtualFile?.url
            ),
            null
        ) { response ->
            if (!isRunning) return@request

            val parsed = response as Map<*, *>

            if (response["done"] as? Boolean == true) {
                handleFinishedResponse()
                return@request
            }

            handleDiffLineResponse(parsed)
        }
    }

    /**
     * 미완성 라인 하이라이트 초기화
     */
    private fun initUnfinishedRangeHighlights() {
        val editorUtils = EditorUtils(editor)
        val unfinishedKey = editorUtils.createTextAttributesKey("CONTINUE_DIFF_UNFINISHED_LINE", 0x20888888)

        for (i in startLine..endLine) {
            val highlighter = editor.markupModel.addLineHighlighter(
                unfinishedKey, min(
                    i, editor.document.lineCount - 1
                ), HighlighterLayer.LAST
            )
            unfinishedHighlighters.add(highlighter)
        }
    }

    /**
     * diff 라인 타입에 따라 처리
     */
    private fun handleDiffLine(type: DiffLineType, text: String) {
        try {
            when (type) {
                DiffLineType.SAME -> handleSameLine()
                DiffLineType.NEW -> handleNewLine(text)
                DiffLineType.OLD -> handleOldLine()
            }

            updateProgressHighlighters(type)
        } catch (e: Exception) {
            println(
                "Error handling diff line - " +
                        "Line index: ${curLine.index}, " +
                        "Line type: $type, " +
                        "Line text: $text, " +
                        "Error message: ${e.message}"
            )
        }
    }

    /**
     * diff 블록 수락/거부 시 상태 및 위치 업데이트
     */
    private fun handleDiffBlockAcceptOrReject(diffBlock: VerticalDiffBlock, didAccept: Boolean) {
        hasAcceptedOrRejectedBlock = true

        diffBlocks.remove(diffBlock)

        if (didAccept) {
            updatePositionsOnAccept(diffBlock.startLine)
        } else {
            updatePositionsOnReject(diffBlock.startLine, diffBlock.addedLines.size, diffBlock.deletedLines.size)
        }

        if (diffBlocks.isEmpty()) {
            setClosed()
        } else {
            // TODO: It's confusing that we pass `DONE` here. What we're doing is updating the UI with the latest
            // diff count. We should have a dedicated status for this.
            sendUpdate(ApplyStateStatus.DONE)
        }
    }

    /**
     * diff 블록 생성
     */
    private fun createDiffBlock(): VerticalDiffBlock {
        val diffBlock = VerticalDiffBlock(
            editor, project, curLine.index, ::handleDiffBlockAcceptOrReject
        )

        diffBlocks.add(diffBlock)
        return diffBlock
    }

    /**
     * SAME 라인 처리
     */
    private fun handleSameLine() {
        if (curLine.diffBlock != null) {
            curLine.diffBlock!!.onLastDiffLine()
        }

        curLine.diffBlock = null

        curLine.index++
    }

    /**
     * NEW 라인 처리
     */
    private fun handleNewLine(text: String) {
        if (curLine.diffBlock == null) {
            curLine.diffBlock = createDiffBlock()
        }

        curLine.diffBlock!!.addNewLine(text, curLine.index)

        curLine.index++
    }

    /**
     * OLD 라인 처리
     */
    private fun handleOldLine() {
        if (curLine.diffBlock == null) {
            curLine.diffBlock = createDiffBlock()
        }

        curLine.diffBlock!!.deleteLineAt(curLine.index)
    }

    /**
     * 현재 라인 및 미완성 하이라이트 갱신
     */
    private fun updateProgressHighlighters(type: DiffLineType) {
        val editorUtils = EditorUtils(editor)
        val curLineKey = editorUtils.createTextAttributesKey("CONTINUE_DIFF_CURRENT_LINE", 0x40888888)

        // 현재 라인 하이라이트 갱신
        curLine.highlighter?.let { editor.markupModel.removeHighlighter(it) }
        curLine.highlighter = editor.markupModel.addLineHighlighter(
            curLineKey, min(curLine.index, max(0, editor.document.lineCount - 1)), HighlighterLayer.LAST
        )

        editorUtils.scrollToLine(curLine.index)

        // 미완성 라인 하이라이트 제거
        if (type != DiffLineType.OLD && unfinishedHighlighters.isNotEmpty()) {
            editor.markupModel.removeHighlighter(unfinishedHighlighters.removeAt(0))
        }
    }

    /**
     * diff 블록 수락 시 위치 업데이트
     */
    private fun updatePositionsOnAccept(startLine: Int) {
        updatePositions(startLine, 0)
    }

    /**
     * diff 블록 거부 시 위치 업데이트
     */
    private fun updatePositionsOnReject(startLine: Int, numAdditions: Int, numDeletions: Int) {
        val offset = -numAdditions + numDeletions
        updatePositions(startLine, offset)
    }

    /**
     * diff 블록 위치 일괄 업데이트
     */
    private fun updatePositions(startLine: Int, offset: Int) {
        diffBlocks.forEach { block ->
            if (block.startLine > startLine) {
                block.updatePosition(block.startLine + offset)
            }
        }
    }

    /**
     * 상태 및 에디터 UI 초기화
     */
    private fun resetState() {
        // 에디터 하이라이트/인레이 제거
        editor.markupModel.removeAllHighlighters()
        diffBlocks.forEach { it.clearEditorUI() }

        // 상태 변수 초기화
        diffBlocks.clear()
        curLine = CurLineState(startLine)
        isRunning = false

        // 편집 입력 종료
        onClose()
    }

    /**
     * 변경사항 전체 undo
     */
    private fun undoChanges() {
        if (virtualFile == null) {
            return
        }

        WriteCommandAction.runWriteCommandAction(project) {
            val undoManager = UndoManager.getInstance(project)
            val fileEditor = FileEditorManager.getInstance(project).getSelectedEditor(virtualFile) as TextEditor

            if (undoManager.isUndoAvailable(fileEditor)) {
                val numChanges = diffBlocks.sumOf { it.deletedLines.size + it.addedLines.size }

                repeat(numChanges) {
                    undoManager.undo(fileEditor)
                }
            }
        }
    }

    /**
     * diff 스트림 완료 처리
     */
    private fun handleFinishedResponse() {
        ApplicationManager.getApplication().invokeLater {
            // Since we only call onLastDiffLine() when we reach a "same" line, we need to handle the case where
            // the last line in the diff stream is in the middle of a diff block.
            curLine.diffBlock?.onLastDiffLine()

            onFinish()
            cleanupProgressHighlighters()

            if (diffBlocks.isEmpty()) {
                setClosed()
            } else {
                sendUpdate(ApplyStateStatus.DONE)
            }
        }
    }

    /**
     * 하이라이트 정리
     */
    private fun cleanupProgressHighlighters() {
        curLine.highlighter?.let { editor.markupModel.removeHighlighter(it) }
        unfinishedHighlighters.forEach { editor.markupModel.removeHighlighter(it) }
    }

    /**
     * diff 라인 응답 처리
     */
    private fun handleDiffLineResponse(parsed: Map<*, *>) {
        val data = parsed["content"] as Map<*, *>
        val diffLineType = getDiffLineType(data["type"] as String)
        val lineText = data["line"] as String

        ApplicationManager.getApplication().invokeLater {
            WriteCommandAction.runWriteCommandAction(project) {
                handleDiffLine(diffLineType, lineText)
            }
        }
    }

    /**
     * 문자열 타입을 DiffLineType으로 변환
     */
    private fun getDiffLineType(type: String): DiffLineType {
        return when (type) {
            "same" -> DiffLineType.SAME
            "new" -> DiffLineType.NEW
            "old" -> DiffLineType.OLD
            else -> throw Exception("Unknown diff line type: $type")
        }
    }

    /**
     * diff 스트림 종료 및 상태 갱신
     */
    private fun setClosed() {
        sendUpdate(ApplyStateStatus.CLOSED)
        resetState()
    }
}