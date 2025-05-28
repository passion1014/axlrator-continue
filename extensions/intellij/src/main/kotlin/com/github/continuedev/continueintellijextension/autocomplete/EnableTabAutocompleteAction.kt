package com.github.continuedev.continueintellijextension.autocomplete

import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
/**
 * Tab 자동완성 기능을 활성화하는 액션입니다.
 * 이 액션이 실행되면 설정에서 enableTabAutocomplete 값을 true로 변경합니다.
 */
class EnableTabAutocompleteAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        // 서비스에서 설정 객체를 가져옵니다.
        val continueSettingsService = service<ContinueExtensionSettings>()
        // Tab 자동완성 활성화 설정을 true로 변경합니다.
        continueSettingsService.continueState.enableTabAutocomplete = true
    }
}
