# OpenAI 어댑터

OpenAI 어댑터는 OpenAI 호환 요청을 다른 API 요청으로 변환하고, 다시 되돌리는 역할을 합니다.

어댑터는 **순수한 변환 계층**으로 다음과 같은 것들은 **관심 대상이 아닙니다**:

- 템플릿
- 모델이 도구, 이미지 등을 지원하는지 여부
- 모델에 따라 API base를 동적으로 변경
- system 메시지 추적 (항상 첫 번째 메시지에 systemMessage가 있음)
- 이미 OpenAI 요청 본문에 전달된 내용을 별도 변수로 보관
- `apiBase`에 슬래시(`/`)를 덧붙이는 작업 (추후 구현 예정)
- 임베딩 배치 처리 (최대 배치 크기에 대한 지식은 필요하지만, 요청 1건 = 응답 1건의 원칙을 지키는 것이 더 중요함)
- `streamChat`을 `streamComplete`에, 또는 그 반대로 사용하는 것 (둘 중 하나만 정의된 경우라도)

어댑터의 목표는 **가능한 한 자주 변경되지 않는 것**입니다. 실제 API 형식이 변경될 때에만 업데이트가 필요해야 합니다.

어댑터는 다음과 같은 작업은 **관심 대상입니다**:

- 모델 별칭 변환
- 캐시 동작
- 최대 중단어(stop word) 수
- 레거시 `completions` 엔드포인트 사용 여부
- 프록시 뒤에 있는 엔드포인트를 클라이언트가 알 수 없는 경우의 기타 처리

---

## 지원되는 API

- [x] Anthropic
- [ ] AskSage
- [x] Azure
- [ ] Bedrock
- [ ] Bedrock Import
- [x] Cerebras
- [ ] Cloudflare
- [x] Cohere
- [x] DeepInfra
- [x] Deepseek
- [ ] Flowise
- [x] Function Network
- [x] Gemini
- [x] Groq
- [ ] HuggingFace Inference API
- [ ] HuggingFace TGI
- [x] Kindo
- [x] LMStudio
- [x] LlamaCpp
- [x] Llamafile
- [x] Msty
- [x] Mistral
- [x] Nvidia
- [x] Nebius
- [x] OpenRouter
- [x] OpenAI
- [ ] !Ollama
- [x] OVHCLoud
- [ ] Replicate
- [ ] SageMaker
- [x] SambaNova
- [x] Scaleway
- [ ] Silicon Flow
- [x] TextGen Web UI
- [x] Together
- [x] Novita AI
- [x] Vllm
- [ ] Vertex AI
- [x] Voyage AI
- [x] WatsonX
- [x] xAI
- [x] Fireworks
- [x] Moonshot
- [x] Anthropic
- [ ] AskSage
- [x] Azure
- [ ] Bedrock
- [ ] Bedrock Import
- [x] Cerebras
- [ ] Cloudflare
- [x] Cohere
- [x] DeepInfra
- [x] Deepseek
- [ ] Flowise
- [x] Function Network
- [x] Gemini
- [x] Groq
- [ ] HuggingFace Inference API
- [ ] HuggingFace TGI
- [x] Kindo
- [x] LMStudio
- [x] LlamaCpp
- [x] Llamafile
- [x] Msty
- [x] Mistral
- [x] Nvidia
- [x] Nebius
- [x] OpenRouter
- [x] OpenAI
- [ ] !Ollama
- [x] OVHCLoud
- [ ] Replicate
- [ ] SageMaker
- [x] SambaNova
- [x] Scaleway
- [ ] Silicon Flow
- [x] TextGen Web UI
- [x] Together
- [x] Novita AI
- [x] Vllm
- [ ] Vertex AI
- [x] Voyage AI
- [x] WatsonX
- [x] xAI
- [x] Fireworks
- [x] Moonshot
