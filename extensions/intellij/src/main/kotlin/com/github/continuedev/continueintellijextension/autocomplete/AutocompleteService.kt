package com.github.continuedev.continueintellijextension.autocomplete

import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.github.continuedev.continueintellijextension.utils.toUriOrNull
import com.github.continuedev.continueintellijextension.utils.uuid
import com.intellij.injected.editor.VirtualFileWindow
import com.intellij.openapi.application.*
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.ServiceManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.InlayProperties
import com.intellij.openapi.editor.impl.EditorImpl
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.wm.WindowManager
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement

/** * 자동완성 후보를 보류 중인 상태를 나타내는 데이터 클래스입니다.
 *
 * @property editor 자동완성을 요청한 에디터
 * @property offset 자동완성 후보가 삽입될 위치의 오프셋
 * @property completionId 자동완성 요청의 고유 ID
 * @property text 자동완성 후보 텍스트
 */
data class PendingCompletion(
    val editor: Editor,
    var offset: Int,
    val completionId: String,
    var text: String?
)


/**
 * PsiElement가 인젝션된 텍스트인지 확인합니다.
 * 인젝션된 텍스트는 VirtualFileWindow를 통해 관리됩니다.
 *
 * @return 인젝션된 텍스트 여부
 */
fun PsiElement.isInjectedText(): Boolean {
    val virtualFile = this.containingFile.virtualFile ?: return false
    if (virtualFile is VirtualFileWindow) {
        return true
    }
    return false
}


/**
 * 에디터에 인레이(Inlay) 요소를 추가합니다.
 * 첫 번째 줄은 인라인 요소로, 나머지 줄은 블록 요소로 추가합니다.
 *
 * @param lines 인레이로 추가할 텍스트 라인 목록
 * @param offset 인레이를 추가할 위치의 오프셋
 * @param properties 인레이 속성
 */
fun Editor.addInlayElement(
    lines: List<String>,
    offset: Int,
    properties: InlayProperties
) {
    if (this is EditorImpl) {
        if (lines[0].isNotEmpty()) {
            inlayModel.addInlineElement(offset, properties, ContinueInlayRenderer(listOf(lines[0])))
        }
        if (lines.size > 1) {
            inlayModel.addBlockElement(offset, properties, ContinueInlayRenderer(lines.drop(1)))
        }
    }
}

/**
 * AutocompleteService는 에디터에서 자동완성 후보를 관리하고 렌더링하는 서비스입니다.
 *
 * 주요 기능:
 * - 자동완성 트리거 및 후보 요청
 * - 자동완성 후보 렌더링 및 수락/부분 수락/취소
 * - 인레이(Inlay) 요소 관리
 * - IDE의 Lookup(코드 자동완성 팝업)과의 상호작용 처리
 *
 * @property pendingCompletion 현재 보류 중인 자동완성 후보 정보
 * @property lastChangeWasPartialAccept 마지막 변경이 부분 수락이었는지 여부
 */
@Service(Service.Level.PROJECT)
class AutocompleteService(private val project: Project) {
    /** 현재 보류 중인 자동완성 후보 */
    var pendingCompletion: PendingCompletion? = null

    /** Lookup(IDE 자동완성 팝업) 상태 리스너 */
    private val autocompleteLookupListener = project.service<AutocompleteLookupListener>()

    /** 상태바에 표시되는 로딩 스피너 위젯 */
    private val widget: AutocompleteSpinnerWidget? by lazy {
        WindowManager.getInstance().getStatusBar(project)
            ?.getWidget(AutocompleteSpinnerWidget.ID) as? AutocompleteSpinnerWidget
    }

    /** 마지막 변경이 부분 수락(partial accept)이었는지 여부 */
    var lastChangeWasPartialAccept = false

    /**
     * 자동완성 후보를 트리거합니다.
     * @param editor 자동완성을 요청할 에디터
     */
    fun triggerCompletion(editor: Editor) {
        val settings =
            ServiceManager.getService(ContinueExtensionSettings::class.java)
        if (!settings.continueState.enableTabAutocomplete) {
            return
        }

        if (pendingCompletion != null) {
            clearCompletions(pendingCompletion!!.editor)
        }

        // 보류 중인 자동완성 후보 설정
        val completionId = uuid()
        val offset = editor.caretModel.primaryCaret.offset
        pendingCompletion = PendingCompletion(editor, offset, completionId, null)

        // core에 자동완성 요청
        val virtualFile = FileDocumentManager.getInstance().getFile(editor.document)
        val uri = virtualFile?.toUriOrNull() ?: return

        widget?.setLoading(true)

        val line = editor.caretModel.primaryCaret.logicalPosition.line
        val column = editor.caretModel.primaryCaret.logicalPosition.column
        val input = mapOf(
            "completionId" to completionId,
            "filepath" to uri,
            "pos" to mapOf(
                "line" to line,
                "character" to column
            ),
            "clipboardText" to "",
            "recentlyEditedRanges" to emptyList<Any>(),
            "recentlyVisitedRanges" to emptyList<Any>(),
        )

        project.service<ContinuePluginService>().coreMessenger?.request(
            "autocomplete/complete",
            input,
            null,
            ({ response ->
                if (pendingCompletion == null || pendingCompletion?.completionId == completionId) {
                    widget?.setLoading(false)
                }

                val responseObject = response as Map<*, *>
                val completions = responseObject["content"] as List<*>

                if (completions.isNotEmpty()) {
                    val completion = completions[0].toString()
                    val finalTextToInsert = deduplicateCompletion(editor, offset, completion)

                    if (shouldRenderCompletion(finalTextToInsert, offset, line, editor)) {
                        renderCompletion(editor, offset, finalTextToInsert)
                        pendingCompletion = PendingCompletion(editor, offset, completionId, finalTextToInsert)
                    }
                }
            })
        )
    }

    /**
     * 자동완성 후보를 렌더링할지 여부를 판단합니다.
     */
    private fun shouldRenderCompletion(completion: String, offset: Int, line: Int, editor: Editor): Boolean {
        if (completion.isEmpty() || runReadAction { offset != editor.caretModel.offset }) {
            return false
        }

        if (completion.lines().size == 1) {
            return true
        }

        val endOffset = editor.document.getLineEndOffset(line)

        // 멀티라인 자동완성의 경우, 커서가 줄 끝에 있을 때만 렌더링
        return offset <= endOffset && editor.document.getText(TextRange(offset, endOffset)).isBlank()
    }

    /**
     * 자동완성 텍스트에서 중복되는 부분을 제거합니다.
     */
    private fun deduplicateCompletion(editor: Editor, offset: Int, completion: String): String {
        // 커서 이후 10글자와 중복되는 부분 제거
        return ApplicationManager.getApplication().runReadAction<String> {
            val document = editor.document
            val caretOffset = editor.caretModel.offset

            // 문서 끝이면 그대로 반환
            if (caretOffset == document.textLength) return@runReadAction completion

            val N = 10
            var textAfterCursor = if (caretOffset + N <= document.textLength) {
                document.getText(TextRange(caretOffset, caretOffset + N))
            } else {
                document.getText(TextRange(caretOffset, document.textLength))
            }

            // 커서 이후가 공백이면 그대로 반환
            if (textAfterCursor.isBlank()) return@runReadAction completion

            // 개행 문자 위치 확인
            val newlineIndex = textAfterCursor.indexOf("\r\n").takeIf { it >= 0 } ?: textAfterCursor.indexOf('\n')
            if (newlineIndex > 0) {
                textAfterCursor = textAfterCursor.substring(0, newlineIndex)
            }

            val indexOfTextAfterCursorInCompletion = completion.indexOf(textAfterCursor)
            if (indexOfTextAfterCursorInCompletion > 0) {
                return@runReadAction completion.slice(0..indexOfTextAfterCursorInCompletion - 1)
            } else if (indexOfTextAfterCursorInCompletion == 0) {
                return@runReadAction ""
            }

            return@runReadAction completion
        }
    }

    /**
     * 자동완성 후보를 인레이로 렌더링합니다.
     */
    private fun renderCompletion(editor: Editor, offset: Int, completion: String) {
        if (completion.isEmpty()) {
            return
        }
        if (isInjectedFile(editor)) return
        // IDE 자동완성 팝업이 떠 있고, 사이드바이사이드 설정이 꺼져 있으면 렌더링하지 않음
        if (shouldSkipRender(ServiceManager.getService(ContinueExtensionSettings::class.java))) {
            return
        }

        ApplicationManager.getApplication().invokeLater {
            WriteAction.run<Throwable> {
                // 기존 자동완성 후보 제거
                hideCompletions(editor)

                val properties = InlayProperties()
                properties.relatesToPrecedingText(true)
                properties.disableSoftWrapping(true)

                val lines = completion.lines()
                pendingCompletion = pendingCompletion?.copy(text = lines.joinToString("\n"))
                editor.addInlayElement(lines, offset, properties)

//                val attributes = TextAttributes().apply {
//                    backgroundColor = JBColor.GREEN
//                }
//                val key = TextAttributesKey.createTextAttributesKey("CONTINUE_AUTOCOMPLETE")
//                key.let { editor.colorsScheme.setAttributes(it, attributes) }
//                editor.markupModel.addLineHighlighter(key, editor.caretModel.logicalPosition.line, HighlighterLayer.LAST)
            }
        }
    }

    /**
     * 자동완성 후보 전체를 수락합니다.
     */
    fun accept() {
        val completion = pendingCompletion ?: return
        val text = completion.text ?: return
        val editor = completion.editor
        val offset = completion.offset
        editor.document.insertString(offset, text)

        editor.caretModel.moveToOffset(offset + text.length)

        project.service<ContinuePluginService>().coreMessenger?.request(
            "autocomplete/accept",
            hashMapOf("completionId" to completion.completionId),
            null,
            ({})
        )
        invokeLater {
            clearCompletions(editor, completion)
        }
    }

    /**
     * IDE 자동완성 팝업이 떠 있을 때 렌더링을 건너뛸지 여부
     */
    private fun shouldSkipRender(settings: ContinueExtensionSettings) =
        !settings.continueState.showIDECompletionSideBySide && !autocompleteLookupListener.isLookupEmpty()

    /**
     * 구분자를 포함하여 문자열을 단어 단위로 분리합니다.
     */
    private fun splitKeepingDelimiters(input: String, delimiterPattern: String = "\\s+"): List<String> {
        val initialSplit = input.split("(?<=$delimiterPattern)|(?=$delimiterPattern)".toRegex())
            .filter { it.isNotEmpty() }

        val result = mutableListOf<String>()
        var currentDelimiter = ""

        for (part in initialSplit) {
            if (part.matches(delimiterPattern.toRegex())) {
                currentDelimiter += part
            } else {
                if (currentDelimiter.isNotEmpty()) {
                    result.add(currentDelimiter)
                    currentDelimiter = ""
                }
                result.add(part)
            }
        }

        if (currentDelimiter.isNotEmpty()) {
            result.add(currentDelimiter)
        }

        return result
    }

    /**
     * 자동완성 후보의 첫 단어만 수락(부분 수락)합니다.
     */
    fun partialAccept() {
        val completion = pendingCompletion ?: return
        val text = completion.text ?: return
        val editor = completion.editor
        val offset = completion.offset

        lastChangeWasPartialAccept = true

        // 단어 단위로 분리하여 첫 단어만 삽입
        val words = splitKeepingDelimiters(text)
        println(words)
        val word = words[0]
        editor.document.insertString(offset, word)
        editor.caretModel.moveToOffset(offset + word.length)

        // 기존 후보 제거 후, 남은 텍스트로 다시 렌더링
        hideCompletions(editor)
        completion.text = text.substring(word.length)
        completion.offset += word.length
        renderCompletion(editor, completion.offset, completion.text!!)
    }

    /**
     * 자동완성 후보 요청을 취소합니다.
     */
    private fun cancelCompletion(completion: PendingCompletion) {
        // core에 취소 메시지 전송
        widget?.setLoading(false)
        project.service<ContinuePluginService>().coreMessenger?.request("autocomplete/cancel", null, null, ({}))
    }

    /**
     * 자동완성 후보 및 인레이를 모두 제거합니다.
     */
    fun clearCompletions(editor: Editor, completion: PendingCompletion? = pendingCompletion) {
        if (isInjectedFile(editor)) return

        if (completion != null) {
            cancelCompletion(completion)
            if (completion.completionId == pendingCompletion?.completionId) pendingCompletion = null
        }
        disposeInlayRenderer(editor)
    }

    /**
     * 인젝션 파일(예: 문자열 리터럴 내 코드) 여부를 확인합니다.
     */
    private fun isInjectedFile(editor: Editor): Boolean {
        return runReadAction {
            PsiDocumentManager.getInstance(project).getPsiFile(editor.document)?.isInjectedText() ?: false
        }
    }

    /**
     * 인레이만 제거(자동완성 후보는 유지)
     */
    fun hideCompletions(editor: Editor) {
        if (isInjectedFile(editor)) return

        disposeInlayRenderer(editor)
    }

    /**
     * 자동완성 인레이 렌더러를 모두 제거합니다.
     */
    private fun disposeInlayRenderer(editor: Editor) {
        editor.inlayModel.getInlineElementsInRange(0, editor.document.textLength).forEach {
            if (it.renderer is ContinueInlayRenderer) {
                it.dispose()
            }
        }
        editor.inlayModel.getBlockElementsInRange(0, editor.document.textLength).forEach {
            if (it.renderer is ContinueInlayRenderer) {
                it.dispose()
            }
        }
    }
}
