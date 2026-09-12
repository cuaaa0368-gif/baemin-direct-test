# Nurion Rider Control DEV + Baemin Direct Collector

사용자가 제공한 `rider-control-dev` 전체를 기준으로, 기존 라이더 앱/UI/API는 유지하고 **배민 관제 수집 주체만 Tampermonkey에서 Render 서버 직접수집으로 추가 전환한 테스트 통합본**입니다.

## 기존 앱 보존
- `public/` 폴더는 DEV 원본과 동일합니다.
- 기존 `/api/login`, `/api/center`, 랭킹, 상세정보, 거절률, 서초대장, 비밀번호 변경 API는 그대로 유지됩니다.
- 기존 `/api/ingest*`도 그대로 유지되어 Tampermonkey 방식과 호환됩니다.

## 새 직접수집
`baemin-direct.js`가 다음 API를 Render에서 직접 호출합니다.
- `/v2/center`
- `/v4/management/delivery-status`
- `/v4/management/rider-delivery-status`

필수 Render 환경변수:
- `BAEMIN_CENTER_ID`
- `BAEMIN_COOKIE`
- `BAEMIN_POLL_MS` (현재 테스트값 20000 사용 가능)

기존 rider-control DB까지 그대로 사용하려면 기존 서비스의 다음 환경변수도 복사합니다.
- `DATABASE_URL`
- `INGEST_KEY`
- `LOGIN_SECRET`

자세한 내용은 `README_DIRECT_MIGRATION.txt` 참고.
