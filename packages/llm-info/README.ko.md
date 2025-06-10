# @continuedev/llm-info

`@continuedev/llm-info`는 임베딩, 재정렬(reranking), 기타 다양한 대형 언어 모델(LLM)에 대한 정보를 제공하는 가벼운 패키지입니다.

`@continuedev/openai-adapters`가 API 형식 간 변환을 담당하는 반면, `@continuedev/llm-info`는 다음과 같은 항목을 다룹니다:

- 템플릿
- 모델 기능 (예: 도구, 이미지, 스트리밍, 예상 출력 등)
- 모델 별칭(alias)

그리고 `openai-adapters`는 이러한 정보의 일부를 위해 `llm-info`에 의존할 수 있습니다.

---

### 목표

Continue에서 새로운 모델을 지원하기 위해 필요한 작업이 정확히 다음 두 단계로 끝나게 되었을 때 완료된 것으로 간주합니다:

1. 하나의 `LlmInfo` 객체만 수정하고
2. 해당 모델을 지원하는 `ModelProviders`에 추가하는 것

---

### 코드 구조

주요 타입은 다음 두 가지입니다:

- `LlmInfo`
- `ModelProvider`

모델 정의는 `models` 디렉터리 안에서 이뤄지며, 필요한 대로 그룹화할 수 있습니다.

프로바이더는 `providers` 디렉터리 내에 정의되며, 그들이 지원하는 모든 모델은 `models` 속성 안에 포함되어야 합니다. 모델이 프로바이더마다 약간 다른 속성(예: 컨텍스트 길이)을 가질 수 있으므로, 모델은 반드시 프로바이더와 연결되어야 합니다. 가능한 많은 정보를 공통(base) 객체에 정의하고, 필요한 경우 해당 프로바이더에 맞게 덮어쓰기(spread) 방식으로 수정합니다.

---

### llm-info 사용처

- `autodetect.ts` 파일을 대체
- `BaseLLM` 생성자에서의 사용 사례를 참고하고, 관련된 모든 부분에서 `llm-info`를 사용하도록 변경
- `gui/pages/AddNewModel/configs/[providers/models].ts` 파일을 대체
