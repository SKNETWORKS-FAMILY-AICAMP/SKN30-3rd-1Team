# RAGAS 채점 — collect_eval.py가 만든 eval_collected.json을 읽어 표준 4개 지표 산출.
# ⚠️ 이 스크립트는 별도 Python 3.12 venv(.venv-eval)에서 실행한다.
#    (ragas 0.2.x는 메인 venv의 Python 3.14 asyncio와 비호환)
# 실행:  .venv-eval\Scripts\python.exe backend/test/ragas_score.py
#
# 표준 4개 지표:
#   context_precision  검색 정밀도(노이즈) — 리트리버
#   context_recall     검색 재현율(누락)   — 리트리버
#   faithfulness       충실도(환각)        — 생성기
#   answer_relevancy   응답 적절성         — 생성기

# ── ragas import 전 vertexai shim ──
import importlib.machinery
import sys
import types
_V = "langchain_community.chat_models.vertexai"
if _V not in sys.modules:
    _m = types.ModuleType(_V)
    _m.__spec__ = importlib.machinery.ModuleSpec(_V, None)
    class ChatVertexAI:
        def __init__(self, *a, **k):
            raise ImportError("not installed")
    _m.ChatVertexAI = ChatVertexAI
    sys.modules[_V] = _m

import json
import os
from pathlib import Path

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[2]

# .env 로드 (OPENAI_API_KEY)
for line in (_REPO / ".env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip("'\""))

from ragas import EvaluationDataset, evaluate
from ragas.llms import llm_factory
from ragas.embeddings import embedding_factory
from ragas.run_config import RunConfig
from ragas.metrics import (
    LLMContextPrecisionWithReference,
    LLMContextRecall,
    Faithfulness,
    ResponseRelevancy,
)

JUDGE = os.getenv("EVAL_JUDGE", "gpt-4o-mini")
rows = json.loads((_HERE.parent / "eval_collected.json").read_text(encoding="utf-8"))
print(f"[RAGAS] 질문 {len(rows)}개, judge={JUDGE}, 지표 4개")

llm = llm_factory(JUDGE)
emb = embedding_factory(model="text-embedding-3-small")
metrics = [
    LLMContextPrecisionWithReference(llm=llm),
    LLMContextRecall(llm=llm),
    Faithfulness(llm=llm),
    ResponseRelevancy(llm=llm, embeddings=emb),
]

ds = EvaluationDataset.from_list(rows)
result = evaluate(dataset=ds, metrics=metrics, run_config=RunConfig(max_workers=4, timeout=300))
print("\n===== RAGAS 표준 4개 지표 =====")
print(result)

df = result.to_pandas()
out = _HERE.parent / "ragas_result.csv"
df.to_csv(out, index=False, encoding="utf-8-sig")
print(f"\n상세 저장: {out.name}")
# 문항별 요약
cols = [c for c in df.columns if c in ("context_precision", "context_recall", "faithfulness", "answer_relevancy")]
for i, r in df.iterrows():
    print(f"  Q{i+1}: " + "  ".join(f"{c}={r[c]:.3f}" for c in cols if r[c] == r[c]))
