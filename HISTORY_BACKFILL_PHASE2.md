# 누리온 장기 이력 Phase 2 - 제어형 백필

- 최근 90일은 기존 운영 수집을 그대로 유지한다.
- 90일 이전부터 약 24개월 범위는 PostgreSQL 장기 이력으로 순차 백필한다.
- 기본 한 배치: 최대 30일.
- 배치 간격: 최소 5분.
- 서버 전체에서 동시에 한 지사만 백필하도록 3분 lease를 사용한다.
- LIVE/주간/90일 작업이 실행 중이면 백필은 다음 날짜 호출 전에 양보한다.
- `nurion_history_backfill_state`에 지사별 진행 커서를 영구 저장한다.
- DB 저장이 성공한 경우에만 커서를 과거 방향으로 이동한다.
- 실패/재배포/재시작 시 마지막 성공 지점부터 재개한다.
- UPSERT는 기존 장기 이력 PK `(stat_date, center_key, rider_user_id)`를 유지한다.
- 랭킹/기록보관소는 기존 center 기준을 변경하지 않는다.

환경변수(선택):
- BAEMIN_HISTORY_BACKFILL_ENABLED=1
- BAEMIN_HISTORY_BACKFILL_MONTHS=24 (12~24)
- BAEMIN_HISTORY_BACKFILL_BATCH_DAYS=30 (5~30)
- BAEMIN_HISTORY_BACKFILL_INTERVAL_MS=300000 (최소 300000)
