# 돈나가요 Chrome 확장프로그램

`extension/` 폴더가 Chrome 웹 스토어에 올리는 원본입니다.

## 확인

```bash
node extension/tests/run.js
```

## 배포 파일 만들기

저장소 루트에서 다음 파일만 ZIP에 포함합니다.

- `manifest.json`
- `background.js`, `content.js`, `popup.js`, `rules.js`, `watch.js`
- `popup.html`, `panel.css`
- `icon16.png`, `icon48.png`, `icon128.png`
- `test.html`, `test.js`

`tests/`와 이 문서는 배포 ZIP에 넣지 않습니다.
