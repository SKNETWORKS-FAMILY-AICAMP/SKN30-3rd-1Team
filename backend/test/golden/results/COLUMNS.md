# 결과 CSV 컬럼 설명 (데이터 사전)

파일명 규칙: `ragas_<코퍼스>_<구성>_<phase>_<runid>.csv`
- 코퍼스: `modu`·`csbot` / 구성: `R0-sql`·`R0-vec`·`R0-both`·`E0`·`E1`·`E2-e2e`
  (+ `oracle_…E2-oracle…`) / phase: `dev`(개발검증)·`final`(보고수치)

## summary.csv (구성별 집계 — 단일 원천)

| 컬럼 | 설명 | 방향 |
|---|---|---|
| run_id | 측정 실행 식별자(타임스탬프) | — |
| date | 측정 날짜 | — |
| commit | 측정 시점 git 커밋 | — |
| corpus | 코퍼스(modu·csbot) | — |
| config | 검색 구성(R0-sql/vec/both·E0·E1·E2-e2e) | — |
| phase | dev(개발검증) / final(보고수치) | — |
| judge | RAGAS 판정 LLM(gpt-4.1-mini) | — |
| n | 채점 대상 비환각 문항 수 | — |
| context_precision | 검색된 컨텍스트 중 정답 관련 비율(**검색 순도**) | 높을수록 노이즈↓ |
| context_recall | 정답에 필요한 근거가 검색된 비율(**누락 없음**) | 높을수록 ↑ |
| faithfulness | 답변 주장이 컨텍스트에 근거한 비율(**환각 반대**) | 높을수록 ↑ |
| response_relevancy | 답변이 질문에 부합하는 정도 | 높을수록 ↑ |
| citation_grounding | 답변이 실제 검색 출처를 `(출처: 파일명)`으로 인용했는지(문항 1.0/0.0 평균, **출처 추적성**, final E0·E2-e2e만) | 높을수록 ↑ |
| routing_accuracy | 라우팅 감사 정확도(**관측값**, 합격 조건 아님) | 참고 |
| history_detect_rate | 이력 질문 감지율(관측값) | 참고 |
| chain_inclusion_rate | 이력 체인 포함률(E2, 기대 pair 문구 포함) | 높을수록 ↑ |
| abstain_rate | 환각 문항 기권률(**환각 방지**) | 높을수록 ↑ |

## ragas_*.csv (문항별 상세)

| 컬럼 | 설명 |
|---|---|
| qid | 문항 ID(A/B/C 세트) |
| tag | 문항 유형(decision·action·conflict·conflict_negative·hallucination) |
| question | 질문 원문 |
| n_contexts | 그 문항에 검색된 컨텍스트 개수(SQL 구조화 기록 + 벡터 청크) |
| context_precision / context_recall / faithfulness / response_relevancy / citation_grounding | 위 summary와 동일한 지표의 **문항 단위 값** |
| history_mode | 이력 질문으로 감지됐는지(True/False) |
| history_rows_added | 이력 체인으로 추가된 구조화 행 수 |
| history_truncated | 이력 체인이 길이 제한으로 잘렸는지 |
| chain_included | 그 문항의 기대 이력 체인이 포함됐는지(E2) |
| abstained | 그 문항에서 기권했는지(환각 문항 대상) |

주: 지표는 판정 LLM(gpt-4.1-mini) 기반이라 재실행 시 소폭 변동 가능. 답변 원문·
검색 근거는 CSV에 없고 로컬 스냅샷 `.eval_state/contexts_*.jsonl`에 있다
(response·sql_contexts·vector_contexts·rendered_context).

## 기타 CSV

- `routing_audit_*.csv` — 라우팅 감사: 문항별 기대/실제 경로·router_stage 대조.
- `pair_coverage_*.csv` — supersede positive/negative pair 적용 커버리지.
- `oracle_*_E2-oracle_*.csv` — E2-oracle 보조 측정(감지 실패 vs 체인 품질 분리).
