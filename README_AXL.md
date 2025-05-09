## Vscode Task 실행

CTRL + SHIFT + P 누르면 tasks: run task 실행

## 폴더 설명

binary: core의 tyscript code를 바이너리로 패키징
docs: 문서 서버
extensions: vscode, intelliJ 플러그인(extension) 패키징
gui: 채팅등 WEB UI 인터페이스를 위한 리액트 앱
scripts: 디펜던시 설치 스크립트

## VSCODE 패키징

--- 패키지 빌드하여 vsix 파일 생성

1. 실행전 gui 가 한번이라도 빌드 되어 있어야 함
   C:\Users\hellf\vscode\axlrator-continue\gui> npm run build
2. 패키징
   C:\Users\hellf\vscode\axlrator-continue\extensions\vscode> npm run package
3. 패키징 파일을 이용해서 vscode 플러그인을 설치
   C:\Users\hellf\vscode\axlrator-continue\extensions\vscode\build\continue-1.0.7.vsix

## IntelliJ 패키징

1. 패키징
   C:\Users\hellf\vscode\axlrator-continue\extensions\intellij>.\gradlew.bat buildPlugin
2. zip파일이 생성된다
   C:\Users\hellf\vscode\axlrator-continue\extensions\intellij\build\distributions\continue-intellij-extension-1.0.13.zip

3. 빌드가 제대로 안되면 다음처럼 새로 빌드
   .\gradlew.bat clean buildPlugin --no-build-cache
   .\gradlew.bat clean buildPlugin --no-build-cache --no-configuration-cache
