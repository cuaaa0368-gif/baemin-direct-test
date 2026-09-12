# Baemin Render Direct Test

목적: 브라우저/Tampermonkey 밖의 Render 서버가 현재 인증 세션으로
배민 관제 API를 직접 호출할 수 있는지 검증하는 최소 테스트 서비스.

## 필요한 Render 환경변수

- BAEMIN_CENTER_ID
- BAEMIN_COOKIE
- BAEMIN_POLL_MS (기본 20000)

중요: BAEMIN_COOKIE 값은 ChatGPT/메신저/깃허브에 올리지 말고
Render Dashboard > Environment 에 직접 입력하세요.

## 테스트 엔드포인트

- /health
- /test
- /center

성공 기준:
- /center => status 200
- /test => status 200

401/403이면 현재 쿠키 세트가 부족하거나 만료된 상태입니다.
