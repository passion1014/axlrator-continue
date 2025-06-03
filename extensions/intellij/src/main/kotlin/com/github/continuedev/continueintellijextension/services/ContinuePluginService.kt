package com.github.continuedev.continueintellijextension.services

import com.github.continuedev.continueintellijextension.`continue`.CoreMessenger
import com.github.continuedev.continueintellijextension.`continue`.CoreMessengerManager
import com.github.continuedev.continueintellijextension.`continue`.DiffManager
import com.github.continuedev.continueintellijextension.`continue`.IdeProtocolClient
import com.github.continuedev.continueintellijextension.toolWindow.ContinuePluginToolWindowFactory
import com.github.continuedev.continueintellijextension.utils.uuid
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.DumbAware
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlin.properties.Delegates

/**
 * Continue 플러그인의 상태와 상호작용을 관리하는 서비스입니다.
 */
@Service(Service.Level.PROJECT)
class ContinuePluginService : Disposable, DumbAware {
    private val coroutineScope = CoroutineScope(Dispatchers.Main)
    var continuePluginWindow: ContinuePluginToolWindowFactory.ContinuePluginWindow? = null
    var listener: (() -> Unit)? = null
    var ideProtocolClient: IdeProtocolClient? by Delegates.observable(null) { _, _, _ ->
        synchronized(this) { listener?.also { listener = null }?.invoke() }
    }
    var coreMessengerManager: CoreMessengerManager? = null
    val coreMessenger: CoreMessenger?
        get() = coreMessengerManager?.coreMessenger
    var workspacePaths: Array<String>? = null
    var windowId: String = uuid()
    var diffManager: DiffManager? = null

    override fun dispose() {
        coroutineScope.cancel()
        coreMessenger?.coroutineScope?.let {
            it.cancel()
            coreMessenger?.killSubProcess()
        }
    }

    fun sendToWebview(
        messageType: String,
        data: Any?,
        messageId: String = uuid()
    ) {
        continuePluginWindow?.browser?.sendToWebview(messageType, data, messageId)
    }

    /**
     * protocolClient 초기화 리스너를 추가합니다.
     * 현재는 하나만 처리하면 됩니다. 만약 여러 개가 필요하다면,
     * 배열을 사용해 리스너를 추가하여 메시지가 처리되도록 할 수 있습니다.
     */
    fun onProtocolClientInitialized(listener: () -> Unit) {
        if (ideProtocolClient == null) {
            synchronized(this) {
                if (ideProtocolClient == null) {
                    this.listener = listener
                } else {
                    listener()
                }
            }
        } else {
            listener()
        }
    }

    fun updateLastFileSaveTimestamp() {
        ideProtocolClient?.updateLastFileSaveTimestamp()
    }
}