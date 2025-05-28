package com.github.continuedev.continueintellijextension.services

import com.intellij.openapi.components.Service
import com.posthog.java.PostHog
import com.posthog.java.PostHog.Builder


/**
 * TelemetryService는 PostHog를 사용하여 원격 분석 이벤트를 추적하는 서비스입니다.
 *
 * - setup(distinctId): PostHog 클라이언트를 초기화하고 사용자 식별자를 설정합니다.
 * - capture(eventName, properties): 이벤트와 속성을 PostHog로 전송합니다.
 * - shutdown(): PostHog 클라이언트를 종료합니다.
 */
@Service
class TelemetryService {
    private val POSTHOG_API_KEY = "phc_JS6XFROuNbhJtVCEdTSYk6gl5ArRrTNMpCcguAXlSPs"
    private var posthog: PostHog? = null;
    private var distinctId: String? = null;
    
    /**
     * PostHog 클라이언트를 초기화하고 사용자 식별자를 설정합니다.
     */
    fun setup(distinctId: String) {
        this.posthog = Builder(POSTHOG_API_KEY).host("https://app.posthog.com").build()
        this.distinctId = distinctId
    }

    /**
     * 이벤트와 속성을 PostHog로 전송합니다.
     * 클라이언트 또는 식별자가 없으면 아무 작업도 하지 않습니다.
     */
    fun capture(eventName: String, properties: Map<String, *>) {
        if (this.posthog == null || this.distinctId == null) {
            return;
        }
        try {
            this.posthog?.capture(this.distinctId, eventName, properties)
        } catch (e: Exception) {
            // 예외 무시
        }
    }

    /**
     * PostHog 클라이언트를 종료합니다.
     */
    fun shutdown() {
        this.posthog?.shutdown()
    }
}