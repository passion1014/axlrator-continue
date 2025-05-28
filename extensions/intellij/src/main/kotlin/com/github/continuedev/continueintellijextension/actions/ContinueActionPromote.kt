package com.github.continuedev.continueintellijextension.actions

import com.github.continuedev.continueintellijextension.autocomplete.AcceptAutocompleteAction
import com.github.continuedev.continueintellijextension.services.ContinueExtensionSettings
import com.intellij.openapi.actionSystem.ActionPromoter
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.components.ServiceManager
import org.jetbrains.annotations.NotNull

/**
 * Continue 관련 액션의 우선순위를 조정하는 ActionPromoter 구현체입니다.
 * - AcceptAutocompleteAction이 포함되어 있고, 설정에서 showIDECompletionSideBySide가 true인 경우 해당 액션만 우선시합니다.
 * - RejectDiffAction이 포함되어 있으면 해당 액션만 우선시합니다.
 * - 그 외에는 기본 우선순위를 따릅니다.
 */
class ContinueActionPromote : ActionPromoter {

    override fun promote(@NotNull actions: List<AnAction>, @NotNull context: DataContext): List<AnAction>? {
        // 자동완성 관련 액션 우선 처리
        if (actions.any { it is AcceptAutocompleteAction }) {
            val settings = ServiceManager.getService(ContinueExtensionSettings::class.java)
            if (settings.continueState.showIDECompletionSideBySide) {
                return actions.filterIsInstance<AcceptAutocompleteAction>()
            }
        }

        // Diff 거부 액션 우선 처리
        val rejectDiffActions = actions.filterIsInstance<RejectDiffAction>()
        if (rejectDiffActions.isNotEmpty()) {
            return rejectDiffActions
        }

        // 기본 우선순위
        return null
    }
}