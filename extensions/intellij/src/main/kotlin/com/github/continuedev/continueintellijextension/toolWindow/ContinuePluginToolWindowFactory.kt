package com.github.continuedev.continueintellijextension.toolWindow

import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.components.ServiceManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import javax.swing.*

const val JS_QUERY_POOL_SIZE = "200"

/**
 * ContinuePluginToolWindowFactory는 IntelliJ 툴 윈도우에 Continue 브라우저를 임베드하는 팩토리 클래스입니다.
 *
 * 주요 기능:
 * - 툴 윈도우에 Continue 웹뷰를 생성 및 추가
 * - 타이틀 액션(사이드바 액션, 최대화 등) 등록
 * - JCEF 관련 시스템 프로퍼티 설정
 *
 * @constructor 기본 생성자
 */
class ContinuePluginToolWindowFactory : ToolWindowFactory, DumbAware {
    /**
     * 툴 윈도우에 Continue 웹뷰 콘텐츠를 생성하여 추가합니다.
     *
     * @param project 현재 프로젝트 인스턴스
     * @param toolWindow 툴 윈도우 인스턴스
     */
  override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
    val continueToolWindow = ContinuePluginWindow(project)
    val content =
        ContentFactory.getInstance().createContent(continueToolWindow.content, null, false)
    toolWindow.contentManager.addContent(content)
    val titleActions = mutableListOf<AnAction>()
    createTitleActions(titleActions)

        // MaximizeToolWindow 액션 추가
    val action = ActionManager.getInstance().getAction("MaximizeToolWindow")
    if (action != null) {
      titleActions.add(action)
    }

    toolWindow.setTitleActions(titleActions)
  }

    /**
     * 툴 윈도우 타이틀에 표시할 액션들을 생성합니다.
     *
     * @param titleActions 액션 리스트
     */
  private fun createTitleActions(titleActions: MutableList<in AnAction>) {
    val action = ActionManager.getInstance().getAction("ContinueSidebarActionsGroup")
    if (action != null) {
      titleActions.add(action)
    }
  }

  override fun shouldBeAvailable(project: Project) = true

    /**
     * Continue 웹뷰를 생성하고 관리하는 내부 클래스입니다.
     *
     * @param project 현재 프로젝트 인스턴스
     */
  class ContinuePluginWindow(project: Project) {
    private val defaultGUIUrl = "http://continue/index.html"

    init {
            // JCEF 관련 시스템 프로퍼티 설정
      System.setProperty("ide.browser.jcef.jsQueryPoolSize", JS_QUERY_POOL_SIZE)
      System.setProperty("ide.browser.jcef.contextMenu.devTools.enabled", "true")
    }

        /**
         * Lazy로 생성되는 ContinueBrowser 인스턴스
         */
    val browser: ContinueBrowser by lazy {
      val url = System.getenv("GUI_URL")?.toString() ?: defaultGUIUrl

      val browser = ContinueBrowser(project, url)
      val continuePluginService =
          ServiceManager.getService(project, ContinuePluginService::class.java)
      continuePluginService.continuePluginWindow = this
      browser
    }

        /**
         * 툴 윈도우에 표시될 Swing 컴포넌트
         */
    val content: JComponent
      get() = browser.browser.component
  }
}
