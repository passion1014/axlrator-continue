# Continue Core Binary

이 폴더의 목적은 TypeScript 코드를 어떤 IDE나 플랫폼에서도 실행할 수 있도록 패키징하는 것입니다.
먼저 `esbuild`로 번들링한 후, `pkg`를 사용해 바이너리로 패키징합니다.

`pkgJson/package.json`은 `pkg`로 빌드할 때 필요한 설정을 담고 있으며, 별도의 폴더에 위치해야 합니다.
그 이유는 `assets` 옵션을 위한 CLI 플래그가 없기 때문이며, `pkg`는 반드시 파일 이름이 `package.json`인 경우만 인식합니다.
그리고 일반적인 `package.json`에 의존성을 포함시키면 `pkg`가 이 모든 의존성을 바이너리에 포함시켜 버리기 때문에, 바이너리 크기가 크게 증가합니다.
그래서 따로 관리하는 것입니다.

그 외의 빌드 프로세스는 전부 `build.js`에 정의되어 있습니다.

---

### 📦 네이티브 모듈 목록

- `sqlite3/build/Release/node_sqlite3.node` (\*)
- `@lancedb/**`
- `esbuild?`
- `@esbuild?`
- `onnxruntime-node?`

(\*) = 각 플랫폼별로 수동으로 다운로드해야 함

---

### 📦 동적으로 import되는 모듈 목록

- `posthog-node`
- `@octokit/rest`
- `esbuild`

---

### 📦 .wasm 파일 목록

- `tree-sitter.wasm`
- `tree-sitter-wasms/`

---

## 🐞 디버깅

IntelliJ에서 바이너리를 디버깅하려면 `CoreMessenger.kt`의 `useTcp` 값을 `true`로 설정하세요.
그리고 VSCode에서는 "Core Binary" 디버그 스크립트를 실행하세요.

이렇게 하면 stdin/stdout으로 바이너리 서브프로세스를 실행하는 대신,
IntelliJ 확장이 VSCode에서 시작된 서버에 TCP를 통해 연결됩니다.
이후 `core`나 `binary` 폴더 내의 코드에 브레이크포인트를 걸어 디버깅할 수 있습니다.

---

## 🛠️ 빌드

```bash
npm run build
```

---

## ✅ 테스트

```bash
npm run test
```
