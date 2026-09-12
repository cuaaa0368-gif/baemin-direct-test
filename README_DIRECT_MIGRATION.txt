누리온 DEV + 배민 Render 직접수집 통합본
========================================

이 ZIP은 사용자가 보낸 rider-control DEV 전체를 기준으로 만들었습니다.
public 폴더(UI/이미지/PWA/app.js/style.css)는 수정하지 않았습니다.

핵심 변경
---------
1) baemin-direct.js 추가
   - BAEMIN_CENTER_ID + BAEMIN_COOKIE로 Render가 배민 API 직접 호출
   - /v4/management/delivery-status 직접 수집
   - /v4/management/rider-delivery-status 직접 수집
   - Set-Cookie 응답이 오면 메모리 cookie jar 자동 갱신

2) 기존 Tampermonkey 수집 결과와 같은 형태로 기존 서버 API에 내부 전송
   - /api/ingest/:centerKey
   - /api/ingest-weekly/:centerKey
   - /api/ingest-reject/:centerKey
   - /api/ingest-history/:centerKey

   따라서 기존 프론트/API 동작을 바꾸지 않고 수집 주체만 Render로 교체합니다.

3) 실행 주기
   - LIVE: BAEMIN_POLL_MS (현재 20000이면 20초)
   - 주간/랭킹/거절: 30초
   - 90일 상세이력: 서버 시작 후 자동 1회 + 매일 10:00 KST
   - /v2/center 인증 확인: 5분

4) 기존 Tampermonkey 호환 유지
   - BAEMIN_CENTER_ID 또는 BAEMIN_COOKIE가 없으면 직접수집만 비활성화됩니다.
   - 기존 /api/ingest* 엔드포인트는 그대로 살아 있습니다.

현재 테스트 서비스에서 이미 있는 환경변수
----------------------------------------
BAEMIN_CENTER_ID
BAEMIN_COOKIE
BAEMIN_POLL_MS

기존 라이더 앱의 DB/계정/서초대장/비밀번호 변경까지 기존과 같은 DB로 쓰려면
기존 rider-control-test Render의 아래 환경변수를 새 baemin-direct-test에도 복사하세요.

DATABASE_URL
INGEST_KEY
LOGIN_SECRET

코드 수정은 필요 없습니다.

배포 후 정상 로그 예시
--------------------
[BAEMIN DIRECT] START center=seocho/서초 interval=20000ms
[BAEMIN CENTER] 200 OK ...
[BAEMIN LIVE] OK riders=...
[BAEMIN WEEKLY] OK ...
[BAEMIN REJECT] OK ...
[BAEMIN HISTORY] OK ...

/health 에서 baeminDirect 상태도 확인할 수 있습니다.
쿠키 실제 값은 로그/health에 출력하지 않습니다.
