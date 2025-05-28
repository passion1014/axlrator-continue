package com.github.continuedev.continueintellijextension.activities

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

/**
 * 이 서비스는 플러그인 전체 수명 주기를 나타내는 부모 Disposable입니다.
 * 프로젝트/애플리케이션 대신 사용되며, 이를 부모 Disposable로 등록한 Disposable은
 * 플러그인이 언로드될 때 처리되어 메모리 누수를 방지합니다.
 *
 * @author lk
 */
@Service(Service.Level.APP, Service.Level.PROJECT)
class ContinuePluginDisposable : Disposable {

    // 플러그인이 언로드될 때 호출되는 메서드
    override fun dispose() {
    }

    companion object {

        /**
         * 애플리케이션 수준에서 `ContinuePluginDisposable` 인스턴스를 가져옵니다.
         */
        fun getInstance(): ContinuePluginDisposable {
            return ApplicationManager.getApplication().getService(ContinuePluginDisposable::class.java)
        }

        /**
         * 프로젝트 수준에서 `ContinuePluginDisposable` 인스턴스를 가져옵니다.
         */
        fun getInstance(project: Project): ContinuePluginDisposable {
            return project.getService(ContinuePluginDisposable::class.java)
        }

    }
}