package com.github.continuedev.continueintellijextension.autocomplete

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.impl.EditorImpl
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.ui.JBColor
import com.intellij.util.ui.UIUtil
import java.awt.Font
import java.awt.Graphics
import java.awt.Rectangle

/**
 * The `ContinueInlayRenderer` class is responsible for rendering custom inlay elements within an editor.
 * It implements the [EditorCustomElementRenderer] interface to provide custom rendering logic for inlays.
 *
 * This renderer is designed to display a list of text lines (`lines`) within the editor, calculating the
 * necessary width and height based on the content and rendering each line with appropriate font and color.
 *
 * @author lk
 */
/**
 * 에디터 인레이에 자동완성 후보 텍스트를 렌더링하는 커스텀 렌더러입니다.
 * lines: 렌더링할 문자열 리스트(줄 단위)
 */
class ContinueInlayRenderer(val lines: List<String>) : EditorCustomElementRenderer {

    /**
     * 인레이의 가로 픽셀 크기를 계산합니다.
     * 가장 긴 줄의 픽셀 길이를 반환합니다.
     */
    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        var maxLen = 0;
        for (line in lines) {
            // 각 줄의 픽셀 길이 측정
            val len = (inlay.editor as EditorImpl).getFontMetrics(Font.PLAIN).stringWidth(line)
            if (len > maxLen) {
                maxLen = len
            }
        }
        return maxLen
    }

    /**
     * 인레이의 세로 픽셀 크기를 계산합니다.
     * 줄 수에 따라 높이를 결정합니다.
     */
    override fun calcHeightInPixels(inlay: Inlay<*>): Int {
        return (inlay.editor as EditorImpl).lineHeight * lines.size
    }

    /**
     * 에디터의 폰트 정보를 가져옵니다.
     */
    private fun font(editor: Editor): Font {
        val editorFont = editor.colorsScheme.getFont(EditorFontType.PLAIN)
        // 폰트 fallback 적용
        return UIUtil.getFontWithFallbackIfNeeded(editorFont, lines.joinToString("\n"))
            .deriveFont(editor.colorsScheme.editorFontSize)
    }

    /**
     * 인레이 영역에 텍스트를 실제로 그립니다.
     */
    override fun paint(
        inlay: Inlay<*>,
        g: Graphics,
        targetRegion: Rectangle,
        textAttributes: TextAttributes
    ) {
        val editor = inlay.editor
        g.color = JBColor.GRAY // 텍스트 색상 지정
        g.font = font(editor) // 폰트 지정
        var additionalYOffset = 0
        val ascent = editor.ascent
        val lineHeight = editor.lineHeight
        // 각 줄을 순서대로 그리기
        for (line in lines) {
            g.drawString(line, targetRegion.x, targetRegion.y + ascent + additionalYOffset)
            additionalYOffset += lineHeight
        }
    }
}