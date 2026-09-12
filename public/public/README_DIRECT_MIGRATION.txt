누리온 DEV + 배민 Render 직접수집 통합본 v2

필수 Render 환경변수
- INGEST_KEY : 기존 rider-control-test와 동일값
- BAEMIN_CENTER_ID
- BAEMIN_COOKIE
- BAEMIN_POLL_MS=20000 (현재 테스트값)

선택
- BAEMIN_CENTER_KEY=seocho
- BAEMIN_CENTER_NAME=서초
- BAEMIN_HISTORY_ON_START=1

이번 v2 수정 핵심
1) 기존 Tampermonkey fetchDateMap과 동일하게 rider-delivery-status가 특정 날짜에서 HTTP 400이면
   전체 WEEKLY/REJECT/HISTORY 동기화를 중단하지 않고 해당 날짜만 빈 데이터로 건너뜀.
2) 따라서 오늘 LIVE 데이터로 rejectCenters가 정상 생성되어 rider userId + 초기비밀번호 1234 로그인이 가능.
3) /health에 rejectCenters/historyCenters/baeminDirect 상태 추가.
4) public 폴더는 DEV 원본 그대로 유지.

로그인 준비 확인 로그
[BAEMIN REJECT] OK riders=...
[LOGIN READY] rider default login source ready: ... riders

주의
DATABASE_URL이 없는 기존 테스트 환경에서는 DB 저장 관련 로그가 실패할 수 있지만,
메모리 기반 관제/로그인/앱 테스트는 동작한다. DB 영속 기능은 별도 DB 연결 시 활성화된다.
