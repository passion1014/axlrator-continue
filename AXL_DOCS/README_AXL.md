# 📦 프로젝트 가이드

## 🏗️ Architecture

```Text
         [ GUI (React App) ]
               |
               | (웹 요청 또는 이벤트 메시지)
               v
            [ Core (TypeScript 기반 공통모듈) ]
               /    \
 (Dependency) /      \ (개발:TCP:3000포트, 운영: IPC)
             /        \
            /          \
         VSCode      IntelliJ


```

## ✅ 필요 준비물

- Node.js version **20.19.0 (LTS)** or higher
- **VSCode**
- **IntelliJ** [Community 버전도 괜찮음]

---

## 개발환경 설정

- VSCODE: GUI(리액트), CORE(타입스크립트), Vscode Extention(타입스크립트) 개발
- IntelliJ: IntelliiJ Extention(코틀린) 개발
  1. axlrator-continue\extensions\intellij의 폴더 열기.
  2. gradle로 필요 라이브러리 설치(자동설치)
  3. Setting>Plugins에서 Plugin DevKit 설치

## 디버깅 방법

TODO:

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

### CORE로 데이터 요청방법

**GUI에서 요청:**

```ts
extra.ideMessenger.request("history/delete", { id });
```

---

**IntelliJ 에서 요청**

```kotlin
continuePluginService.coreMessenger?.request("files/deleted", data, null) { _ -> }
```

---

**CORE에서 수신:**

`core/core.ts` 에서 핸들러 구현

```ts
on("history/delete", (msg) => {
  historyManager.delete(msg.data.id);
});
```

---
