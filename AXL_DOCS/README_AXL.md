## Vscode Task 실행

CTRL + SHIFT + P 누르면 tasks: run task 실행

## 폴더 설명

binary: core의 tyscript code를 바이너리로 패키징.

> esbuild == 타입스크립트를 자바스크립트로 트랜스코딩, pkg == 자바스크립트를 바이너리로 빌드
> docs: 문서 서버
> extensions: vscode, intelliJ 플러그인(extension) 패키징
> gui: 채팅등 WEB UI 인터페이스를 위한 리액트 앱
> scripts: 디펜던시 설치 스크립트

## GUI 빌드

1. C:\Users\hellf\vscode\axlrator-continue\gui> npm run build

## VSCODE 패키징

--- 패키지 빌드하여 vsix 파일 생성

1. 실행전 gui 빌드 되어 있어야 함
   그렇지 않으면 'Error: gui build did not produce index.js' 오류 출력
2. 패키징을 하여 vsix파일 생성
   C:\Users\hellf\vscode\axlrator-continue\extensions\vscode> npm run package
3. 패키징 파일을 이용해서 vscode 플러그인을 설치
   C:\Users\hellf\vscode\axlrator-continue\extensions\vscode\build\continue-1.0.7.vsix

## IntelliJ 패키징

1. 패키징
   C:\Users\hellf\vscode\axlrator-continue\extensions\intellij> gradlew.bat buildPlugin
2. 인텔리제이서 File > Settings > Plugins > 설정버튼 > Install Plugin from Disk를 선택하여 생성된 zip을 선택하면 플러그인이 설치된다.
   C:\Users\hellf\vscode\axlrator-continue\extensions\intellij\build\distributions\continue-intellij-extension-1.0.13.zip

3. 빌드가 제대로 안되면 다음처럼 새로 빌드
   .\gradlew.bat clean buildPlugin --no-build-cache
   .\gradlew.bat clean buildPlugin --no-build-cache --no-configuration-cache

## 데이터 흐름

# GUI -> CORE

gui에서 요청

```
extra.ideMessenger.request("history/delete", { id });
```

코어모듈에서 수신: core\core.ts

```
on("history/delete", (msg) => {
   historyManager.delete(msg.data.id);
   });
```
