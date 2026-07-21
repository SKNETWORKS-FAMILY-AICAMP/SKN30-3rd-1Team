# PaiM 골든셋 평가 보고서

- 대상 run: `RUNID=20260719-2329`
- judge: `gpt-4.1-mini` (dev·final 통일)
- 코퍼스: `modu`, `csbot` (각 비환각 26 + 환각 4 = 30문항)
- 설계 정본: `backend/test/golden/EVAL_DESIGN.md` / 하네스: `run_eval.py`
- 측정 방식: **context 지표는 dev 실측 승격**, **생성·인용 지표는 final E0·E2-e2e
  증분**(faithfulness·response_relevancy·citation_grounding).
- 엑셀 요약: `docs/EVAL_REPORT.xlsx` (`export_report.py`로 재생성).

## 1. 최종 결과 (phase=final)

| 코퍼스 | 구성 | ctx_precision | ctx_recall | faithfulness | citation_grounding |
|---|---|---|---|---|---|
| modu | E0 | 0.301 | 0.981 | 0.773 | 1.000 |
| modu | E2-e2e | 0.307 | 0.981 | 0.772 | 1.000 |
| csbot | E0 | 0.340 | 0.962 | 0.786 | 1.000 |
| csbot | E2-e2e | 0.329 | 0.962 | 0.752 | 0.962 |

- **출처 추적성(citation_grounding)**: 4구성 중 3개 1.0, csbot E2-e2e 0.962 —
  답변이 유형 라벨이 아니라 **실제 출처 파일명**을 근거로 인용함이 수치로 확인.
- context_recall 0.96~0.98, faithfulness 0.75~0.79로 안정적.

## 2. 계층 기여 분석 (dev, context 지표)

| 코퍼스 | R0-sql | R0-vec | R0-both | E0 | E1 | E2-e2e |
|---|---|---|---|---|---|---|
| modu  ctx_precision | 0.087 | 0.740 | 0.083 | 0.305 | 0.328 | 0.306 |
| modu  ctx_recall | 0.808 | 0.904 | 0.981 | 0.962 | 0.981 | 0.981 |
| csbot ctx_precision | 0.147 | 0.768 | 0.110 | 0.364 | 0.338 | 0.339 |
| csbot ctx_recall | 0.596 | 0.962 | 0.110→0.962 | 1.000 | 1.000 | 0.962 |

- naive 결합(R0-both) 대비 **하이브리드(E0)가 ctx_precision을 3~4배 개선**
  (modu 0.083→0.305, csbot 0.110→0.364)하면서 recall은 0.96~1.0로 유지 —
  RRF(dense+BM25+recency) 융합·BM25 유관 선별의 효과.
- E1·E2 계층에서 context 지표는 큰 변화 없음(계층 1~3은 주로 이력·번복 정합성
  개선이 목적이며, 이는 체인 포함률·인용 등 다른 축에서 확인).

## 3. context_precision이 낮게 나온 원인 (분석)

**결론: 낮은 ctx_precision은 결함이 아니라 "구조화 사실 누락 방지"를 위한
recall 우선 검색 설계의 의도된 비용이다.**

### 근거
1. **검색 소스별 정밀도 격차** (dev):
   - 벡터만(R0-vec): **0.74~0.77** — top-5 RRF로 질문에 밀착, 정밀.
   - SQL만(R0-sql): **0.09~0.15** — 구조화 기록 검색이 저정밀.
   - naive 결합(R0-both): **0.08~0.11** — SQL이 전체를 희석.
2. **컨텍스트 구성 비대칭** (final E2-e2e 스냅샷 실측):
   - 문항당 평균 **SQL 구조화 기록 13~16행 + 벡터 청크 5개** — SQL이 컨텍스트
     수의 대부분을 차지.
3. **원인**: `mysql_search.search`는 category를 하드 필터가 아닌 소프트
   우선순위로 쓰고(경계 모호한 decision/action을 하드 컷하면 recall 하락),
   문항당 `MYSQL_TOP_N(12)`~`QA_MYSQL_ROWS_LIMIT` 범위의 행을 반환한다. 특정
   질문과 무관한 구조화 행이 다수 포함되어 `context_precision`(검색된 컨텍스트
   중 정답 관련 비율)을 떨어뜨린다. 반면 답변에 필요한 사실은 빠짐없이
   포함되므로 `context_recall`은 0.96~1.0로 높게 유지된다.

### 함의
- 이 값은 **검색 집합의 "순도"** 지표이며, 구조화 기록을 폭넓게 포함하는
  설계상 낮은 것이 자연스럽다. 최종 답변 품질은 recall(누락 없음) +
  faithfulness(근거 충실) + citation(출처 추적)이 함께 담보한다.
- 하이브리드(E0)가 naive 대비 정밀도를 3~4배 끌어올린 것은 **검색 개선이
  실제로 작동**함을 보여준다. 절대 precision이 중간대인 것은 MySQL의 포괄성 때문.
- **개선 여지(후속)**: 문항별 SQL 행 관련도 재랭킹·상한 축소로 precision을 더
  올릴 수 있으나 recall 하락 위험이 있어, 현재는 recall 우선을 선택.

## 4. 출처 추적성 상세 및 경계 사례

- citation_grounding 판정: 답변의 `(출처: 라벨)` 마커를 **검색된 출처 라벨을
  경계로 파싱**해, 실제 검색 출처를 인용했는지 1.0/0.0으로 채점(구분자·다중
  출처·저장소 repo 라벨 안전, 본문 우연 언급·유형 라벨·허위 출처는 0점).
- **경계 사례 — csbot A7** ("LLM 모델 최신 업데이트 이유·비용"): 답변이
  올바른 파일을 인용했으나 마커가
  `(출처: 2026-06-16_개선방안_확정.md, 2026-06-16_개선방안_확정.md 원문)`로,
  파일명 뒤에 **"원문"을 덧붙여**(구조화 기록 vs 원문 맥락 구분 의도) 정확한
  라벨이 아니게 되어 엄격 파서가 0점 처리. **실제 파일은 추적 가능하므로
  사람의 문서 확인에는 지장 없는 형식상 감점**이다. 재현되는 패턴은 아니며
  (답변 비결정성), 지표를 이 접미까지 관대하게 인정하면 허위 출처 오통과 위험이
  커져 현재는 엄격 기준을 유지한다.

## 5. 기타 관측 지표 (dev)

| 지표 | modu | csbot | 비고 |
|---|---|---|---|
| routing_accuracy | 0.567 | 0.533 | 관측값(라우터는 구성 독립), 다수 LLM 폴백 |
| chain_inclusion(E2-e2e) | 0.000 | 1.000 | 이력 체인 포함률 — modu 0.0은 **후속 확인 대상**(TASK-007 범위 밖) |
| abstain_rate | 1.000 | 0.75~1.0 | 환각 문항 기권률 |

- `routing_accuracy`·`chain_inclusion`은 합격 조건이 아닌 **관측 지표**다.
- **modu의 E2-e2e chain_inclusion=0.0**은 이력 체인 포함이 기대만큼 되지 않았음을
  시사하며, TASK-007(출처 인용)과 별개의 후속 진단 항목으로 남긴다.

## 6. 한계

- `context_precision`은 recall 우선 검색 설계상 낮게 나오는 순도 지표다(§3).
- `citation_grounding`은 마커 형식에 엄격하다(§4의 A7 경계 사례).
- 답변 생성 비결정성으로 인용 수치가 소폭 변동한다(직전 run에선 modu C10이
  0.962였으나 본 run에선 1.0).
- `routing`·`chain`은 관측 지표이며 일부 문항은 LLM 폴백이라 비결정 가능.

## 7. 산출물 · 재현

- `results/summary.csv`(citation_grounding 포함), 문항별 상세
  `results/ragas_<corpus>_<config>_<phase>_<runid>.csv`,
  `results/METHODS_20260719-2329.md`.
- 추적 스냅샷(로컬 전용, gitignore): `.eval_state/contexts_*.jsonl` —
  문항별 답변·SQL/벡터 근거·인용·LLM 입력 전문.
- 엑셀 요약: `docs/EVAL_REPORT.xlsx`.
- 재현:
  ```bash
  RUNID=20260719-2329
  .venv/bin/python backend/test/golden/run_eval.py all --corpus modu  --phase dev  --runid $RUNID
  .venv/bin/python backend/test/golden/run_eval.py all --corpus csbot --phase dev  --runid $RUNID
  bash .agent-workflow/tasks/TASK-007/remeasure-task007.sh   # final 생성·인용 증분
  .venv/bin/python backend/test/golden/export_report.py      # → docs/EVAL_REPORT.xlsx
  ```
