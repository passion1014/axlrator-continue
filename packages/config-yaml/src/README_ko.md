# config.yaml 사양

이 사양은 아직 작업 중이며 변경될 수 있습니다.

## config.yaml 파일 불러오기

`config.yaml`은 다음 단계에 따라 불러옵니다.

## 전개(Unrolling)

"소스" `config.yaml`은 전개되어 포함된 패키지들이 모두 하나의 `config.yaml`로 병합됩니다.  
이 작업은 모든 패키지를 재귀적으로 로드하고 병합하여 하나의 `config.yaml`을 생성하는 방식으로 수행됩니다.

이 작업은 서버에서 수행되며, 로컬 모드를 사용하는 경우는 예외입니다.

## 클라이언트 렌더링

전개된 `config.yaml`은 클라이언트에서 렌더링됩니다.  
이때 사용자 시크릿 템플릿 변수는 실제 값으로 치환되며, 그 외의 시크릿들은 시크릿 위치로 대체됩니다.

## 배포(Publishing)

`npm login`으로 npm 레지스트리에 로그인했는지 확인하세요.

그 후, `package.json`의 버전을 올린 다음 다음 명령어를 실행합니다:

```bash
npm run build
npm publish --access public
```
