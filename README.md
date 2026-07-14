# 손끝 승부

Teachable Machine 이미지 모델을 사용하는 오프라인 가위바위보 웹 게임입니다. 실행 시 인터넷 연결이 필요하지 않습니다.

## 바로 실행하기

설치 없이 아래 주소를 Chrome 또는 Edge에서 열고 카메라 권한을 허용하세요.

**https://aquariurn.github.io/rcp-web/**

> 배포된 웹사이트를 사용할 때는 모델과 라이브러리를 처음 내려받기 위한 인터넷 연결이 필요합니다. Python이나 별도 프로그램은 설치하지 않아도 됩니다.

## 모델 준비

1. Teachable Machine 모델 화면에서 `Export Model`을 누릅니다.
2. `Tensorflow.js` 탭에서 `Download my model`을 선택해 다운로드합니다.
3. 압축을 풀어 나온 다음 파일을 이 프로젝트의 `model/` 폴더에 넣습니다.

```text
model/
├── model.json
├── metadata.json
└── weights.bin
```

모델 클래스 이름은 `가위`, `바위`, `보` 또는 `scissors`, `rock`, `paper`여야 합니다.

## 실행

카메라는 보안 정책상 `file://`에서 제한될 수 있으므로 로컬 서버로 실행하세요.

```bash
python3 -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 엽니다. AI 라이브러리와 모델을 모두 프로젝트 내부에서 읽으므로 이후 인터넷 연결을 끊어도 사용할 수 있습니다.

다른 노트북으로 옮길 때는 `vendor/`와 `model/` 폴더를 포함한 프로젝트 전체를 복사하세요.
