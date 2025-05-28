package com.github.continuedev.continueintellijextension.toolWindow

import com.github.continuedev.continueintellijextension.activities.ContinuePluginDisposable
import com.github.continuedev.continueintellijextension.constants.MessageTypes.Companion.PASS_THROUGH_TO_CORE
import com.github.continuedev.continueintellijextension.factories.CustomSchemeHandlerFactory
import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.github.continuedev.continueintellijextension.utils.uuid
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.*
import com.intellij.ui.jcef.JBCefClient.Properties
import com.intellij.util.application
import org.cef.CefApp
import org.cef.browser.CefBrowser
import org.cef.handler.CefLoadHandlerAdapter

/**
 * ContinueBrowser는 JCEF 기반의 브라우저를 생성하고,
 * 웹뷰와 플러그인 간의 메시지 통신을 담당하는 클래스입니다.
 *
 * 주요 기능:
 * - 커스텀 스킴 핸들러 등록
 * - 브라우저 인스턴스 생성 및 OSR(Off-Screen Rendering) 설정
 * - 브라우저와의 양방향 메시지 통신(JBCefJSQuery)
 * - 페이지 로드 완료 시 JavaScript 함수 삽입
 * - 웹뷰로 메시지 전송
 *
 * @param project 현재 프로젝트 인스턴스
 * @param url 로드할 웹뷰 URL
 */
class ContinueBrowser(val project: Project, url: String) {
    /**
     * 커스텀 스킴 핸들러를 등록합니다.
     */
    private fun registerAppSchemeHandler() {
        CefApp.getInstance().registerSchemeHandlerFactory(
            "http",
            "continue",
            CustomSchemeHandlerFactory()
        )
    }

    /** JCEF 브라우저 인스턴스 */
    val browser: JBCefBrowser

    /** 플러그인 서비스 인스턴스 */
    val continuePluginService: ContinuePluginService = project.getService(ContinuePluginService::class.java)

    init {
        // OSR(Off-Screen Rendering) 활성화 여부 설정
        val isOSREnabled = application.getService(ContinueExtensionSettings::class.java).continueState.enableOSR

        // 브라우저 인스턴스 생성 및 JS_QUERY_POOL_SIZE 설정
        this.browser = JBCefBrowser.createBuilder().setOffScreenRendering(isOSREnabled).build().apply {
            // To avoid using System.setProperty to affect other plugins,
            // we should configure JS_QUERY_POOL_SIZE after JBCefClient is instantiated,
            // and eliminate the 'Uncaught TypeError: window.cefQuery_xxx is not a function' error
            // in the JS debug console, which is caused by ContinueBrowser lazy loading.
            jbCefClient.setProperty(Properties.JS_QUERY_POOL_SIZE, JS_QUERY_POOL_SIZE)
        }

        // 커스텀 스킴 핸들러 등록
        registerAppSchemeHandler()
        // 브라우저 리소스 해제 등록
        Disposer.register(ContinuePluginDisposable.getInstance(project), browser)

        // 브라우저에서 오는 메시지 수신용 JSQuery 생성
        val myJSQueryOpenInBrowser = JBCefJSQuery.create((browser as JBCefBrowserBase?)!!)

        // 브라우저에서 메시지 수신 시 처리 핸들러 등록
        myJSQueryOpenInBrowser.addHandler { msg: String? ->
            val parser = JsonParser()
            val json: JsonObject = parser.parse(msg).asJsonObject
            val messageType = json.get("messageType").asString
            val data = json.get("data")
            val messageId = json.get("messageId")?.asString

            // 응답 함수 정의
            val respond = fun(data: Any?) {
                sendToWebview(messageType, data, messageId ?: uuid())
            }

            // Core로 전달해야 하는 메시지인 경우
            if (PASS_THROUGH_TO_CORE.contains(messageType)) {
                continuePluginService.coreMessenger?.request(messageType, data, messageId, respond)
                return@addHandler null
            }

            // 그 외 메시지는 웹뷰에 상태/내용/완료 형식으로 전달
            val respondToWebview = fun(data: Any?) {
                sendToWebview(messageType, mapOf(
                    "status" to "success",
                    "content" to data,
                    "done" to true
                ), messageId ?: uuid())
            }

            if (msg != null) {
                continuePluginService.ideProtocolClient?.handleMessage(msg, respondToWebview)
            }

            null
        }

        // 페이지 로드 완료 이벤트 리스너 등록
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(
                browser: CefBrowser?,
                isLoading: Boolean,
                canGoBack: Boolean,
                canGoForward: Boolean
            ) {
                if (!isLoading) {
                    // 페이지 로드 완료 시 JS 함수 삽입
                    executeJavaScript(browser, myJSQueryOpenInBrowser)
                }
            }
        }, browser.cefBrowser)

        // protocolClient 초기화 후에만 URL 로드
        continuePluginService.onProtocolClientInitialized {
            browser.loadURL(url)
        }
    }

    /**
     * 웹뷰에 postIntellijMessage JS 함수를 삽입합니다.
     */
    fun executeJavaScript(browser: CefBrowser?, myJSQueryOpenInBrowser: JBCefJSQuery) {
        val script = """window.postIntellijMessage = function(messageType, data, messageId) {
                const msg = JSON.stringify({messageType, data, messageId});
                ${myJSQueryOpenInBrowser.inject("msg")}
            }""".trimIndent()

        browser?.executeJavaScript(script, browser.url, 0)
    }

    /**
     * 웹뷰로 메시지를 전송합니다.
     *
     * @param messageType 메시지 타입
     * @param data 전송할 데이터
     * @param messageId 메시지 식별자 (기본값: uuid)
     */
    fun sendToWebview(
        messageType: String,
        data: Any?,
        messageId: String = uuid()
    ) {
        val jsonData = Gson().toJson(
            mapOf(
                "messageId" to messageId,
                "messageType" to messageType,
                "data" to data
            )
        )
        val jsCode = buildJavaScript(jsonData)

        try {
            this.browser.executeJavaScriptAsync(jsCode).onError {
                println("Failed to execute jsCode error: ${it.message}")
            }
        } catch (error: IllegalStateException) {
            println("Webview not initialized yet $error")
        }
    }

    /**
     * 웹뷰에서 postMessage를 호출하는 JS 코드를 생성합니다.
     */
    private fun buildJavaScript(jsonData: String): String {
        return """window.postMessage($jsonData, "*");"""
    }
}
