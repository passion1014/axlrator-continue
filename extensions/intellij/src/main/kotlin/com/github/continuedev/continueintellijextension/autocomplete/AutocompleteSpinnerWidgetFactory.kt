package com.github.continuedev.continueintellijextension.autocomplete

import com.github.continuedev.continueintellijextension.activities.ContinuePluginDisposable
import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.WindowManager
import com.intellij.openapi.wm.impl.status.EditorBasedWidget
import com.intellij.ui.AnimatedIcon
import com.intellij.util.Consumer
import java.awt.event.MouseEvent
import javax.swing.Icon
import javax.swing.JLabel

/**
 * 상태바에 표시되는 자동완성 스피너 위젯 클래스입니다.
 * 자동완성 로딩 상태를 애니메이션 아이콘으로 표시합니다.
 */
class AutocompleteSpinnerWidget(project: Project) : EditorBasedWidget(project), StatusBarWidget.IconPresentation,
    Disposable {
    private val iconLabel = JLabel()
    private var isLoading = false
    
    // 로딩 애니메이션 아이콘
    private val animatedIcon = AnimatedIcon.Default()

    init {
        // 플러그인 종료 시 위젯도 함께 dispose
        Disposer.register(ContinuePluginDisposable.getInstance(project), this)
        updateIcon()
    }

    /**
     * 위젯을 표시합니다.
     */
    fun show() {
        println("Showing autocomplete spinner widget")
    }

    override fun dispose() {}

    override fun ID(): String {
        return ID
    }

    /**
     * 툴팁 텍스트를 반환합니다.
     */
    override fun getTooltipText(): String {
        val enabled = service<ContinueExtensionSettings>().state.enableTabAutocomplete
        return if (enabled) "Continue autocomplete enabled" else "Continue autocomplete disabled"
    }

    override fun getClickConsumer(): Consumer<MouseEvent>? {
        return null
    }

    /**
     * 현재 상태에 따라 아이콘을 반환합니다.
     */
    override fun getIcon(): Icon = if (isLoading) animatedIcon else
        IconLoader.getIcon("/icons/continue.svg", javaClass)

    /**
     * 로딩 상태를 설정하고 아이콘을 갱신합니다.
     */
    fun setLoading(loading: Boolean) {
        isLoading = loading
        updateIcon()
    }

    /**
     * 아이콘을 갱신하고 상태바에 반영합니다.
     */
    private fun updateIcon() {
        iconLabel.icon = getIcon()

        // 상태바 위젯 갱신
        val statusBar = WindowManager.getInstance().getStatusBar(project)
        statusBar?.updateWidget(ID())
    }

    override fun install(statusBar: StatusBar) {
        updateIcon()
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation {
        return this
    }

    companion object {
        const val ID = "AutocompleteSpinnerWidget"
    }
}

/**
 * 상태바에 AutocompleteSpinnerWidget을 생성하는 팩토리 클래스입니다.
 */
class AutocompleteSpinnerWidgetFactory : StatusBarWidgetFactory {
    /**
     * AutocompleteSpinnerWidget 인스턴스를 생성합니다.
     */
    fun create(project: Project): AutocompleteSpinnerWidget {
        return AutocompleteSpinnerWidget(project)
    }

    override fun getId(): String {
        return AutocompleteSpinnerWidget.ID
    }

    override fun getDisplayName(): String {
        return "Continue Autocomplete"
    }

    override fun isAvailable(p0: Project): Boolean {
        return true
    }

    override fun createWidget(project: Project): StatusBarWidget {
        return create(project)
    }

    override fun disposeWidget(p0: StatusBarWidget) {
        Disposer.dispose(p0)
    }

    override fun canBeEnabledOn(p0: StatusBar): Boolean = true
}