package com.github.continuedev.continueintellijextension.factories

import com.intellij.openapi.project.DumbAware
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefCallback
import org.cef.callback.CefSchemeHandlerFactory
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefResourceHandler
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse
import java.io.IOException
import java.io.InputStream
import java.net.URLConnection

/**
 * CustomSchemeHandlerFactory는 CEF(Crimean Embedded Framework)에서 커스텀 스킴 요청을 처리하기 위한 팩토리 클래스입니다.
 * create 메서드는 각 요청마다 CustomResourceHandler 인스턴스를 반환합니다.
 */
class CustomSchemeHandlerFactory : CefSchemeHandlerFactory {
    override fun create(
        browser: CefBrowser?,
        frame: CefFrame?,
        schemeName: String,
        request: CefRequest
    ): CefResourceHandler {
        return CustomResourceHandler()
    }
}

/**
 * CustomResourceHandler는 CEF에서 리소스 요청을 처리하는 핸들러입니다.
 * 요청된 URL을 내부 리소스 경로로 변환하여 응답을 제공합니다.
 */
class CustomResourceHandler : CefResourceHandler, DumbAware {
    private var state: ResourceHandlerState = ClosedConnection
    private var currentUrl: String? = null

    /**
     * 요청을 처리하고, 리소스가 존재하면 연결을 오픈합니다.
     */
    override fun processRequest(
        cefRequest: CefRequest,
        cefCallback: CefCallback
    ): Boolean {
        val url = cefRequest.url
        return if (url != null) {
            val pathToResource = url.replace("http://continue", "webview/").replace("http://localhost:5173", "webview/")
            val newUrl = javaClass.classLoader.getResource(pathToResource)
            state = OpenedConnection(newUrl?.openConnection())
            currentUrl = url
            cefCallback.Continue()
            true
        } else {
            false
        }
    }

    /**
     * 응답 헤더를 설정합니다. MIME 타입은 URL에 따라 결정됩니다.
     */
    override fun getResponseHeaders(
        cefResponse: CefResponse,
        responseLength: IntRef,
        redirectUrl: StringRef
    ) {
        if (currentUrl !== null) {
            when {
                currentUrl!!.contains("css") -> cefResponse.mimeType = "text/css"
                currentUrl!!.contains("js") -> cefResponse.mimeType = "text/javascript"
                currentUrl!!.contains("html") -> cefResponse.mimeType = "text/html"
                else -> {}
            }
        }

        state.getResponseHeaders(cefResponse, responseLength, redirectUrl)
    }

    /**
     * 응답 데이터를 읽어 바이트 배열에 씁니다.
     */
    override fun readResponse(
        dataOut: ByteArray,
        bytesToRead: Int,
        bytesRead: IntRef,
        callback: CefCallback
    ): Boolean {
        return state.readResponse(dataOut, bytesToRead, bytesRead, callback)
    }

    /**
     * 요청을 취소하고 연결을 닫습니다.
     */
    override fun cancel() {
        state.close()
        state = ClosedConnection
    }
}

/**
 * ResourceHandlerState는 리소스 핸들러의 상태를 나타내는 sealed 클래스입니다.
 * 각 상태별로 응답 헤더, 데이터 읽기, 연결 닫기 동작을 정의합니다.
 */
sealed class ResourceHandlerState {
    open fun getResponseHeaders(
        cefResponse: CefResponse,
        responseLength: IntRef,
        redirectUrl: StringRef
    ) {
    }

    open fun readResponse(
        dataOut: ByteArray,
        bytesToRead: Int,
        bytesRead: IntRef,
        callback: CefCallback
    ): Boolean = false

    open fun close() {}
}


/**
 * OpenedConnection은 리소스 연결이 열린 상태를 나타냅니다.
 * 실제 데이터 스트림을 통해 응답을 제공합니다.
 */
class OpenedConnection(private val connection: URLConnection?) :
    ResourceHandlerState() {

    private val inputStream: InputStream? by lazy {
        connection?.inputStream
    }

    /**
     * 연결이 열려 있을 때 응답 헤더를 설정합니다.
     * MIME 타입은 리소스 경로에 따라 결정됩니다.
     */
    override fun getResponseHeaders(
        cefResponse: CefResponse,
        responseLength: IntRef,
        redirectUrl: StringRef
    ) {
        try {
            if (connection != null) {
                val fullUrl = connection.url.toString()
                // JAR prefix 이후의 경로만 추출하여 올바른 MIME 타입을 결정
                val url = fullUrl.substringAfterLast("jar!/", fullUrl)
                when {
                    url.contains("css") -> cefResponse.mimeType = "text/css"
                    url.contains("js") -> cefResponse.mimeType = "text/javascript"
                    url.contains("html") -> cefResponse.mimeType = "text/html"
                    else -> cefResponse.mimeType = connection.contentType
                }
                responseLength.set(inputStream?.available() ?: 0)
                cefResponse.status = 200
            } else {
                // 연결이 null인 경우 에러 처리
                cefResponse.error = CefLoadHandler.ErrorCode.ERR_FAILED
                cefResponse.statusText = "Connection is null"
                cefResponse.status = 500
            }
        } catch (e: IOException) {
            cefResponse.error = CefLoadHandler.ErrorCode.ERR_FILE_NOT_FOUND
            cefResponse.statusText = e.localizedMessage
            cefResponse.status = 404
        }
    }

    /**
     * 데이터 스트림에서 데이터를 읽어 응답합니다.
     */
    override fun readResponse(
        dataOut: ByteArray,
        bytesToRead: Int,
        bytesRead: IntRef,
        callback: CefCallback
    ): Boolean {
        return inputStream?.let { inputStream ->
            val availableSize = inputStream.available()
            return if (availableSize > 0) {
                val maxBytesToRead = minOf(availableSize, bytesToRead)
                val realBytesRead = inputStream.read(dataOut, 0, maxBytesToRead)
                bytesRead.set(realBytesRead)
                true
            } else {
                inputStream.close()
                false
            }
        } ?: false
    }

    /**
     * 연결을 닫습니다.
     */
    override fun close() {
        inputStream?.close()
    }
}

/**
 * ClosedConnection은 연결이 닫힌 상태를 나타냅니다.
 * 모든 요청에 대해 404 상태를 반환합니다.
 */
object ClosedConnection : ResourceHandlerState() {
    override fun getResponseHeaders(
        cefResponse: CefResponse,
        responseLength: IntRef,
        redirectUrl: StringRef
    ) {
        cefResponse.status = 404
    }
}
