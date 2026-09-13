# 누리온 장기 상세정보 구조

- 최근 90일: 기존 Render 메모리 캐시 유지.
- 장기 원본: `nurion_rider_history` PostgreSQL 영구 저장.
- 지사 이동: DB에는 `center_key`를 보존하되 개인 상세 조회는 rider identity 기준으로 지사 경계를 넘는다.
- identity alias: `rider_identity_aliases`에 누리온 로그인 identity와 지사별 rider_user_id 이력을 누적한다.
- 랭킹/기록보관소: 기존대로 center_key 기준. 이 패치에서 랭킹 기준은 변경하지 않는다.
- 월간: 월 단위 DB 조회, 브라우저 월 캐시, 앞/뒤 월 prefetch.
- 주간/일별/기간조회: 90일 밖으로 이동하면 필요한 월만 DB에서 조회.
- UI 조회 범위: 최근 24개월.
- DB 적재: 기존 90일 수집 배치가 들어올 때 동일 배치를 DB 장기 이력에도 batch UPSERT한다.
- 과거 90일보다 오래된 기존 배민 데이터는 별도 backfill 작업이 필요하다. 사용자 조회 요청이 배민 API 대량 수집을 직접 유발하지 않게 의도적으로 분리했다.
