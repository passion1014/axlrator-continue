# 📦 프로젝트 가이드

## ✅ 필요 준비물

- Node.js version **20.19.0 (LTS)** or higher
- **VSCode**
- **IntelliJ** [Community 버전도 괜찮음]

---

## 📥 디펜던시 한꺼번에 설치

- **Unix**:

  ```bash
  ./scripts/install-dependencies.sh
  ```

- **Windows**:

  ```powershell
  .\scripts\install-dependencies.ps1
  ```

---

## 🧩 VSCode Extension 가이드

- 자세한 내용은 [`CONTRIBUTING.md`](CONTRIBUTING.md) 참고

---

## 🧠 IntelliJ Extension 가이드

- 자세한 내용은 [`extensions/intellij/CONTRIBUTING.md`](extensions/intellij/CONTRIBUTING.md) 참고

---

## ⚙️ VSCode Task 실행 방법

- `Ctrl + Shift + P`
- `Tasks: Run Task` 실행

---

## 📁 주요 폴더 설명

| 폴더명       | 설명                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `binary`     | core의 TypeScript 코드를 바이너리로 패키징. esbuild:타입스크립트를 자바스크립트로 트랜스파일, pkg: 자바스크립트를 바이너리로 빌드 |
| `docs`       | 웹에서 참조하는 문서[메뉴얼] 서버                                                                                                 |
| `extensions` | VSCode, IntelliJ 플러그인(extension) 패키징                                                                                       |
| `gui`        | 채팅 등 Web UI 인터페이스를 위한 React 앱                                                                                         |
| `scripts`    | 디펜던시 설치 스크립트                                                                                                            |

---

## 🛠️ GUI 빌드 [React 빌드]

```bash
cd gui
npm run build
```

---

## 📦 VSCode 패키징

1. **먼저 GUI가 빌드되어 있어야 함**
   그렇지 않으면 `"Error: gui build did not produce index.js"` 오류 발생

2. VSIX 파일 생성

   ```bash
   cd extensions/vscode
   npm run package
   ```

3. 생성된 `.vsix` 파일로 VSCode 플러그인 설치

   ```text
   extensions\vscode\build\continue-1.0.7.vsix
   ```

---

## 📦 IntelliJ 패키징

1. 패키징 실행

   ```bash
   cd extensions/intellij
   gradlew.bat buildPlugin
   ```

2. IntelliJ 설치 경로
   File > Settings > Plugins > ⚙ 버튼 > **Install Plugin from Disk**
   → 생성된 zip 선택:

   ```text
   extensions\intellij\build\distributions\continue-intellij-extension-1.0.13.zip
   ```

3. 빌드가 제대로 되지 않을 경우

   ```bash
   .\gradlew.bat clean buildPlugin --no-build-cache
   .\gradlew.bat clean buildPlugin --no-build-cache --no-configuration-cache
   ```

---

## 🔁 데이터 흐름

### GUI → CORE

**GUI에서 요청:**

```ts
extra.ideMessenger.request("history/delete", { id });
```

**CORE에서 수신:**

`core/core.ts`

```ts
on("history/delete", (msg) => {
  historyManager.delete(msg.data.id);
});
```

---

### IntelliJ → CORE

```kotlin
continuePluginService.coreMessenger?.request("files/deleted", data, null) { _ -> }
```

---

## 🏗️ Architecture

### Core

> _(여기 내용은 미작성 상태로 보이니 필요 시 추가해 주세요)_

---

필요 시 PDF나 Notion 포맷으로도 변환해드릴 수 있습니다.
더 다듬고 싶은 부분 있으면 알려줘요!
