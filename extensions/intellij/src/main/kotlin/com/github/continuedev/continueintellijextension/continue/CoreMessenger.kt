package com.github.continuedev.continueintellijextension.`continue`

import com.github.continuedev.continueintellijextension.constants.MessageTypes
import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.github.continuedev.continueintellijextension.services.TelemetryService
import com.github.continuedev.continueintellijextension.utils.uuid
import com.google.gson.Gson
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.io.*
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermission
import kotlinx.coroutines.*

/**
 * CoreMessenger는 IDE와 외부 Continue Core 프로세스(또는 TCP 서버) 간의 메시지 통신을 담당하는 클래스입니다.
 *
 * 주요 기능:
 * - 메시지 전송 및 응답 리스너 관리
 * - Core 프로세스 실행 및 종료 처리
 * - TCP 또는 서브프로세스 방식 지원
 * - 파일 권한 설정(맥/리눅스)
 * - Core 프로세스 종료 시 콜백 및 텔레메트리 전송
 *
 * @param project 현재 프로젝트 인스턴스
 * @param continueCorePath 실행할 Core 바이너리 경로
 * @param ideProtocolClient IDE와의 프로토콜 메시지 핸들러
 * @param coroutineScope 코루틴 실행 범위
 */
class CoreMessenger(
    private val project: Project,
    continueCorePath: String,
    private val ideProtocolClient: IdeProtocolClient,
    val coroutineScope: CoroutineScope
) {
    /** Core 프로세스에 메시지를 쓰기 위한 Writer */
    private var writer: Writer? = null
    /** Core 프로세스에서 메시지를 읽기 위한 Reader */
    private var reader: BufferedReader? = null
    /** 실행 중인 Core 프로세스 인스턴스 */
    private var process: Process? = null
    /** JSON 직렬화/역직렬화용 Gson 인스턴스 */
    private val gson = Gson()
    /** 메시지 ID별 응답 리스너 맵 */
    private val responseListeners = mutableMapOf<String, (Any?) -> Unit>()
    /** TCP 사용 여부 (환경변수 USE_TCP) */
    private val useTcp: Boolean = System.getenv("USE_TCP")?.toBoolean() ?: false

    /**
     * Core 프로세스에 문자열 메시지를 전송합니다.
     */
    private fun write(message: String) {
        try {
            writer?.write(message + "\r\n")
            writer?.flush()
        } catch (e: Exception) {
            println("Error writing to Continue core: $e")
        }
    }

    /**
     * Core에 메시지를 전송하고, 응답을 받으면 onResponse 콜백을 호출합니다.
     *
     * @param messageType 메시지 타입
     * @param data 전송할 데이터
     * @param messageId 메시지 ID(생략 시 자동 생성)
     * @param onResponse 응답 콜백
     */
    fun request(messageType: String, data: Any?, messageId: String?, onResponse: (Any?) -> Unit) {
        val id = messageId ?: uuid()
        val message =
            gson.toJson(mapOf("messageId" to id, "messageType" to messageType, "data" to data))
        responseListeners[id] = onResponse
        write(message)
    }

    /**
     * Core 또는 TCP로부터 받은 메시지를 처리합니다.
     * - IDE 메시지: ideProtocolClient로 위임
     * - Webview로 전달할 메시지: ContinuePluginService로 전달
     * - 응답 메시지: 등록된 리스너 호출
     */
    private fun handleMessage(json: String) {
        val responseMap = gson.fromJson(json, Map::class.java)
        val messageId = responseMap["messageId"].toString()
        val messageType = responseMap["messageType"].toString()
        val data = responseMap["data"]

        // IDE listeners
        if (MessageTypes.ideMessageTypes.contains(messageType)) {
            ideProtocolClient.handleMessage(json) { data ->
                val message =
                    gson.toJson(
                        mapOf("messageId" to messageId, "messageType" to messageType, "data" to data)
                    )
                write(message)
            }
        }

        // Forward to webview
        if (MessageTypes.PASS_THROUGH_TO_WEBVIEW.contains(messageType)) {
            val continuePluginService = project.service<ContinuePluginService>()
            continuePluginService.sendToWebview(messageType, responseMap["data"], messageType)
        }

        // Responses for messageId
        responseListeners[messageId]?.let { listener ->
            listener(data)
            val done = (data as Map<String, Boolean>)["done"]

            if (done == true) {
                responseListeners.remove(messageId)
            }
        }
    }

    /**
     * 맥/리눅스에서 실행 파일 권한을 설정합니다.
     */
    private fun setPermissions(destination: String) {
        val osName = System.getProperty("os.name").toLowerCase()
        if (osName.contains("mac") || osName.contains("darwin")) {
            ProcessBuilder("xattr", "-dr", "com.apple.quarantine", destination).start().waitFor()
            setFilePermissions(destination, "rwxr-xr-x")
        } else if (osName.contains("nix") || osName.contains("nux")) {
            setFilePermissions(destination, "rwxr-xr-x")
        }
    }

    /**
     * POSIX 파일 권한을 설정합니다.
     */
    private fun setFilePermissions(path: String, posixPermissions: String) {
        val perms = HashSet<PosixFilePermission>()
        if (posixPermissions.contains("r")) perms.add(PosixFilePermission.OWNER_READ)
        if (posixPermissions.contains("w")) perms.add(PosixFilePermission.OWNER_WRITE)
        if (posixPermissions.contains("x")) perms.add(PosixFilePermission.OWNER_EXECUTE)
        Files.setPosixFilePermissions(Paths.get(path), perms)
    }

    /** Core 프로세스 종료 시 호출할 콜백 목록 */
    private val exitCallbacks: MutableList<() -> Unit> = mutableListOf()

    /**
     * Core 프로세스 종료 시 실행할 콜백을 등록합니다.
     */
    fun onDidExit(callback: () -> Unit) {
        exitCallbacks.add(callback)
    }

    /**
     * CoreMessenger 초기화 블록
     * - TCP 또는 서브프로세스 방식에 따라 Core와 연결
     * - 메시지 수신 루프 시작
     * - 프로세스 종료 시 콜백 및 리소스 정리
     */
    init {
        if (useTcp) {
            try {
                val socket = Socket("127.0.0.1", 3000)
                val writer = PrintWriter(socket.getOutputStream(), true)
                this.writer = writer
                val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                this.reader = reader

                Thread {
                    try {
                        while (true) {
                            val line = reader.readLine()
                            if (line != null && line.isNotEmpty()) {
                                try {
                                    handleMessage(line)
                                } catch (e: Exception) {
                                    println("Error handling message: $line")
                                    println(e)
                                }
                            } else {
                                Thread.sleep(100)
                            }
                        }
                    } catch (e: IOException) {
                        e.printStackTrace()
                    } finally {
                        try {
                            reader.close()
                            writer.close()
                        } catch (e: IOException) {
                            e.printStackTrace()
                        }
                    }
                }
                    .start()
            } catch (e: Exception) {
                println("TCP Connection Error: Unable to connect to 127.0.0.1:3000")
                println("Reason: ${e.message}")
                e.printStackTrace()
            }
        } else {
            // Set proper permissions synchronously
            runBlocking(Dispatchers.IO) {
                setPermissions(continueCorePath)
            }
            
            // Start the subprocess
            val processBuilder =
                ProcessBuilder(continueCorePath).directory(File(continueCorePath).parentFile)
            process = processBuilder.start()

            val outputStream = process!!.outputStream
            val inputStream = process!!.inputStream

            writer = OutputStreamWriter(outputStream, StandardCharsets.UTF_8)
            reader = BufferedReader(InputStreamReader(inputStream, StandardCharsets.UTF_8))

            process!!.onExit().thenRun {
                exitCallbacks.forEach { it() }
                var err = process?.errorStream?.bufferedReader()?.readText()?.trim()
                if (err != null) {
                    // There are often "⚡️Done in Xms" messages, and we want everything after the last one
                    val delimiter = "⚡ Done in"
                    val doneIndex = err.lastIndexOf(delimiter)
                    if (doneIndex != -1) {
                        err = err.substring(doneIndex + delimiter.length)
                    }
                }

                println("Core process exited with output: $err")

                // Log the cause of the failure
                val telemetryService = service<TelemetryService>()
                telemetryService.capture("jetbrains_core_exit", mapOf("error" to err))

                // Clean up all resources
                writer?.close()
                reader?.close()
                process?.destroy()
            }

            coroutineScope.launch(Dispatchers.IO) {
                try {
                    while (true) {
                        val line = reader?.readLine()
                        if (line != null && line.isNotEmpty()) {
                            try {
                                handleMessage(line)
                            } catch (e: Exception) {
                                println("Error handling message: $line")
                                println(e)
                            }
                        } else {
                            delay(100)
                        }
                    }
                } catch (e: IOException) {
                    e.printStackTrace()
                } finally {
                    try {
                        reader?.close()
                        writer?.close()
                        outputStream.close()
                        inputStream.close()
                        process?.destroy()
                    } catch (e: IOException) {
                        e.printStackTrace()
                    }
                }
            }
        }
    }

    /**
     * Core 서브프로세스를 강제 종료합니다.
     * 콜백도 모두 제거합니다.
     */
    fun killSubProcess() {
        process?.isAlive?.let {
            exitCallbacks.clear()
            process?.destroy()
        }
    }
}