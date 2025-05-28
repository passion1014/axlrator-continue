package com.github.continuedev.continueintellijextension.autocomplete

import com.intellij.codeInsight.lookup.impl.LookupImpl
import com.intellij.codeInsight.lookup.Lookup
import com.intellij.codeInsight.lookup.LookupEvent
import com.intellij.codeInsight.lookup.LookupListener
import com.intellij.codeInsight.lookup.LookupManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AutocompleteLookupListener는 LookupManager의 상태 변화를 감지하여
 * 자동완성 후보와 Lookup(코드 자동완성 팝업 '.'키 누르면 나오는 코드제안 팝업) 간의 상호작용을 관리합니다.
 *
 * - Lookup이 표시되면 자동완성 후보를 숨깁니다.
 * - Lookup이 취소되거나 항목이 선택되면 자동완성 후보를 다시 표시할 수 있도록 상태를 변경합니다.
 * - isLookupEmpty()는 현재 Lookup이 표시되고 있는지 여부를 반환합니다.
 *
 * @param project 이 리스너가 동작할 프로젝트
 */
@Service(Service.Level.PROJECT)
class AutocompleteLookupListener(project: Project) : LookupManagerListener {
    // Lookup이 표시 중인지 여부를 나타내는 플래그 (true: 표시 안 됨, false: 표시 중)
    private val isLookupShown = AtomicBoolean(true)

    /**
     * 현재 Lookup이 표시되고 있는지 여부를 반환합니다.
     */
    fun isLookupEmpty(): Boolean {
        return isLookupShown.get()
    }

    init {
        // LookupManagerListener를 프로젝트 메시지 버스에 등록
        project.messageBus.connect().subscribe(LookupManagerListener.TOPIC, this)
    }

    /**
     * Lookup 활성화 상태가 변경될 때 호출됩니다.
     * 새로운 Lookup이 표시되면 LookupListener를 등록하여 상태를 관리합니다.
     */
    override fun activeLookupChanged(oldLookup: Lookup?, newLookup: Lookup?) {
        val newEditor = newLookup?.editor ?: return
        if (newLookup is LookupImpl) {
            newLookup.addLookupListener(
                object : LookupListener {
                    // Lookup이 표시되면 자동완성 후보를 숨깁니다.
                    override fun lookupShown(event: LookupEvent) {
                        isLookupShown.set(false)
                        ApplicationManager.getApplication().invokeLater {
                            event.lookup.editor.project?.service<AutocompleteService>()?.hideCompletions(newEditor)
                        }
                    }

                    // Lookup이 취소되면 자동완성 후보를 다시 표시할 수 있도록 상태를 변경합니다.
                    override fun lookupCanceled(event: LookupEvent) {
                        isLookupShown.set(true)
                    }

                    // Lookup에서 항목이 선택되면 상태를 변경합니다.
                    override fun itemSelected(event: LookupEvent) {
                        isLookupShown.set(true)
                    }
                })
        }
    }
}
