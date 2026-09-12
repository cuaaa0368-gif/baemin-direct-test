RIDER CONTROL v3 — 다지사 + 권한 기반

이번 버전의 핵심
1. 지사 데이터가 centerKey별로 분리 저장됨.
2. 라이더/일반 계정은 자기 centerKey의 API만 조회 가능.
3. 다른 지사 URL을 직접 입력해도 서버가 403으로 차단.
4. superadmin만 전체 지사 목록 API 사용 가능.
5. 기존 텔레그램 스크립트는 그대로 두고 전송부만 추가.

중요: 현재 서버는 개발판이라 메모리에 데이터를 저장합니다.
서버 재시작 시 계정/관제 데이터가 초기화됩니다.
실서비스 단계에서 DB(PostgreSQL 등)로 교체합니다.

로컬 실행
npm install
npm start

개발용 계정 생성 예시 (서버가 켜진 PC CMD):
curl -X POST http://localhost:8787/api/dev/account -H "Content-Type: application/json" -H "x-ingest-key: change-me-later" -d "{\"loginId\":\"gangnam01\",\"password\":\"1234\",\"role\":\"rider\",\"centerKey\":\"gangnam\",\"name\":\"강남 라이더\"}"

다지사 전송
각 지사의 기존 Tampermonkey에 tampermonkey-addon-template.js를 붙이고
RC_CENTER_KEY / RC_CENTER_NAME만 지사에 맞게 변경합니다.

예:
강남 -> gangnam / 강남
송파 -> songpa / 송파

다음 단계
인터넷 HTTPS 서버 배포 -> DB 연결 -> 실제 6개 지사 등록 -> 라이더 계정 발급/자동 매칭 -> PWA 설치
