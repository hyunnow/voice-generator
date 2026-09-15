# 영어 문장 → MP3 음성 생성기

영어 문장을 입력하면 실제 사람처럼 자연스러운 목소리의 MP3 파일로 만들어 주는 웹앱입니다.

👉 **사용하기: https://hyunnow.github.io/voice-generator/**

## 특징

- **완전 무료** — 서버, API 키, 결제가 전혀 없습니다. GitHub Pages(무료)에 올린 정적 페이지입니다.
- **고품질 음성** — 오픈소스 TTS 모델 [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)(Apache-2.0)을 사용합니다.
- **브라우저에서 직접 실행** — WebGPU(지원 시) 또는 WebAssembly로 내 컴퓨터에서 음성을 만듭니다. 입력한 문장은 외부로 전송되지 않습니다.
- 음성 모델(92MB~326MB)은 처음 한 번만 내려받고, 이후에는 브라우저에 저장되어 바로 실행됩니다.

## 사용법

1. 영어 문장 입력 (여러 문장, 여러 줄 가능)
2. 목소리와 속도 선택
3. **MP3 만들기** → 미리 듣고 **MP3 다운로드**

## 로컬 실행

```bash
python3 -m http.server 8000
```

브라우저에서 http://localhost:8000 에 접속합니다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `index.html` | 화면 |
| `app.js` | 화면 동작 (입력, 결과 목록, 다운로드) |
| `worker.js` | 음성 합성(kokoro-js) + MP3 인코딩(lamejs), 웹 워커에서 실행 |

## 라이선스

- Kokoro-82M 모델, kokoro-js: Apache-2.0
- lamejs: LGPL-3.0
