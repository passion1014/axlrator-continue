package com.github.continuedev.continueintellijextension

        import com.intellij.DynamicBundle
        import org.jetbrains.annotations.NonNls
        import org.jetbrains.annotations.PropertyKey

        // 메시지 번들의 경로를 정의
        @NonNls
        private const val BUNDLE = "messages.MyBundle"

        // 다국어 메시지 번들을 관리하는 객체
        object MyBundle : DynamicBundle(BUNDLE) {

            /**
             * 메시지 번들에서 키에 해당하는 메시지를 가져오는 메서드
             *
             * @param key 메시지 번들에서의 키
             * @param params 메시지에 삽입할 매개변수
             * @return 키에 해당하는 메시지 문자열
             */
            @JvmStatic
            fun message(
                @PropertyKey(resourceBundle = BUNDLE) key: String,
                vararg params: Any
            ) =
                getMessage(key, *params)

            /**
             * 메시지 번들에서 키에 해당하는 메시지를 지연 로드 방식으로 가져오는 메서드
             *
             * @param key 메시지 번들에서의 키
             * @param params 메시지에 삽입할 매개변수
             * @return 키에 해당하는 메시지를 지연 로드 방식으로 반환
             */
            @Suppress("unused")
            @JvmStatic
            fun messagePointer(
                @PropertyKey(resourceBundle = BUNDLE) key: String,
                vararg params: Any
            ) =
                getLazyMessage(key, *params)
        }