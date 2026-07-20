# ⚠️ DEPRECATED (TASK-006): 이 스크립트는 하이브리드 이전 검색을 자체 재구현해
# 측정하며, 정본 평가 파이프라인은 backend/test/golden/run_eval.py 로 대체되었다.
# 유지 이유: 과거 수치(0.571 등)의 재현 참조용. 신규 측정에는 사용하지 말 것.
# RAG 성능 평가 (LangSmith + RAGAS) — 우리 backend 하이브리드 검색을 평가하고
# LangSmith 웹 대시보드에 실험(experiment)으로 기록한다.
#
# 특징:
#   - predict = 우리 backend(qa_engine) 호출  (노트북 RAG 아님)
#   - 채점 = RAGAS 지표(gpt-4.1 판정)
#   - max_concurrency 병렬 실행 → 순차 대비 대폭 단축
#   - LangSmith 프로젝트 'project_test_1' 에 기록
#
# 튜닝: 리트리버 파라미터를 환경변수로 바꿔 재실행 → 실험끼리 웹에서 비교
#   예)  EVAL_K=3 python backend/test/rag_eval_langsmith.py
#
# ⚠️ 파일명 주의: `ragas.py` 금지 (패키지 shadowing).
#
# 실행(SSH 터널 켠 상태):  python backend/test/rag_eval_langsmith.py

# ── ragas import 전 필수 shim (vertexai 모듈 우회) ──
import importlib.machinery
import sys
import types

_VERTEXAI = "langchain_community.chat_models.vertexai"
if _VERTEXAI not in sys.modules:
    _mod = types.ModuleType(_VERTEXAI)
    _mod.__spec__ = importlib.machinery.ModuleSpec(_VERTEXAI, None)

    class ChatVertexAI:
        def __init__(self, *args, **kwargs):
            raise ImportError("ChatVertexAI is not installed.")

    _mod.ChatVertexAI = ChatVertexAI
    sys.modules[_VERTEXAI] = _mod
# ───────────────────────────────────────────────────

import os
from pathlib import Path

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[2]
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv
load_dotenv(dotenv_path=str(_HERE.parent / ".env"), override=True)
os.environ.setdefault("CHROMA_PERSIST_DIR", str(_HERE.parent / ".chroma"))

# LangSmith 실험/트레이스가 찍힐 프로젝트 (요청: project_test_2)
os.environ["LANGSMITH_PROJECT"] = "project_test_2"
os.environ.setdefault("LANGSMITH_TRACING", "true")

from langsmith import Client, evaluate
from ragas import SingleTurnSample
from ragas.metrics import (
    LLMContextPrecisionWithReference,   # 검색 정밀도 (노이즈)
    LLMContextRecall,                   # 검색 재현율 (누락)
    Faithfulness,                       # 충실도 (환각)
    ResponseRelevancy,                  # 응답 적절성
)
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.run_config import RunConfig
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

from backend.retriever import qa_engine

# ── 평가 대상 & 튜닝 파라미터 (환경변수 오버라이드) ──
PROJECT_ID = int(os.getenv("EVAL_PID", "6"))
qa_engine.CHROMA_K = int(os.getenv("EVAL_K", str(qa_engine.CHROMA_K)))
EVAL_MAXDIST = float(os.getenv("EVAL_MAXDIST", "1.2"))  # 구 엔진의 CHROMA_MAX_DISTANCE 대체(현 엔진에 해당 상수 없음)
JUDGE_MODEL = os.getenv("EVAL_JUDGE", "gpt-4.1")   # 채점 모델 (기본 gpt-4.1)
MAX_CONCURRENCY = int(os.getenv("EVAL_CONCURRENCY", "6"))

DATASET_NAME = "PaiM_QA_Testset"

TESTS = [
    ("이 프로젝트에서 결정된 주요 사항들을 나열해줘",
     "감마 인프라를 구형 RTX A6000 배치 아키텍처로 변경, Unsloth 4비트 양자화+가우시안 청킹으로 VRAM 병목 해결, 알파-베타 멀티테넌시 데이터 격리 확인, 이정재 수석이 6/20까지 가우시안 임베딩 최적화 문서 업로드하기로 결정."),
    ("액션 아이템(할 일) 목록을 알려줘",
     "가우시안 임베딩 최적화 명세서 6/20 업로드(지연 시 6/26 강제), 정답셋 취합·공유 6/16, 간편 비밀번호 암호화 모듈 API 6/25, 금융위 가이드라인 검토 보고서 6/20."),
    ("현재 이슈로 보고된 것들은 뭐야?",
     "하드웨어 예산 70% 삭감으로 고가 서버 반려, 구형 RTX 3090 OOM 발생, Gemma-3 추론 속도 2~3토큰/초로 실시간 불가, 100개 평가 데이터셋 구축 진행."),
    ("프로젝트 알파에서 외부 API 도입이 왜 반려됐어?",
     "사내 보안·PII 가이드라인상 민감 데이터가 외부 클라우드/해외 AI로 전송되면 보안 심의를 통과할 수 없고 과거 감사 지적도 있어 반려. 이후 RunPod 프라이빗 자체 구축으로 선회."),
    ("감마 프로젝트가 왜 구형 하드웨어를 쓰게 됐어?",
     "하드웨어 구매 예산이 70% 삭감되어 고가 서버 구매가 반려됐고, 사내 유휴 구형 RTX A6000 배치 아키텍처로 전환했기 때문."),
    ("임원 데모 일정이 왜 연기됐어?",
     "RAG 시스템이 누락된 액션 아이템을 논리적으로 적출하는지 검증하기 위해, 이정재 수석의 누락 태스크 완료 전까지 전사 임원 데모를 7월 2일로 연기함."),
    ("가우시안 임베딩 최적화 작업은 무슨 결정이었고 지금 어떻게 진행되고 있어?",
     "이정재 수석이 6/20까지 가우시안 임베딩 최적화 명세서·튜닝 가이드 작성·업로드하기로 결정했으나, 지연되어 6/26까지 강제 업로드하도록 후속 조치된 상태."),
    ("VRAM 부족 문제는 어떻게 대응하기로 했고 배경이 뭐야?",
     "구형 RTX 3090급 GPU에서 문서 증가 시 OOM(VRAM 부족)이 지속 발생한 것이 배경이며, Unsloth 4비트 양자화+가우시안 청킹으로 VRAM 병목을 해결하기로 결정함."),
    ("보안 때문에 어떤 결정을 했고 그 이유는 뭐야?",
     "민감 데이터 외부 유출 우려(PII·보안심의)로 외부 API/클라우드 반려, RunPod 프라이빗+오픈소스 LLM 자체 구축 결정. 멀티테넌시 데이터 격리도 검증."),
]


def predict(inputs: dict) -> dict:
    """LangSmith가 주는 inputs['question']으로 우리 backend를 실행 → {answer, contexts}."""
    q = inputs["question"]
    context, _sources, debug = qa_engine._build_context(PROJECT_ID, q)
    contexts = (
        [r["content"] for r in debug.get("mysql_rows", [])]
        + [c["text"] for c in debug.get("chroma_chunks", [])]
    )
    answer = qa_engine._get_chain().invoke(
        {"history": [], "context": context, "question": q}
    )
    return {"answer": answer, "contexts": contexts}


def ragas_evaluator(inputs: dict, outputs: dict, reference_outputs: dict) -> list[dict]:
    """RAGAS 4개 지표를 JUDGE_MODEL로 채점. (동시성 안전을 위해 호출마다 지표 생성)"""
    ragas_llm = LangchainLLMWrapper(ChatOpenAI(model=JUDGE_MODEL, temperature=0))
    ragas_emb = LangchainEmbeddingsWrapper(OpenAIEmbeddings(model="text-embedding-3-small"))

    sample = SingleTurnSample(
        user_input=inputs["question"],
        retrieved_contexts=outputs["contexts"],
        response=outputs["answer"],
        reference=reference_outputs["reference"],
    )
    metrics = [
        LLMContextPrecisionWithReference(llm=ragas_llm),
        LLMContextRecall(llm=ragas_llm),
        Faithfulness(llm=ragas_llm),
        ResponseRelevancy(llm=ragas_llm, embeddings=ragas_emb),
    ]
    results = []
    for m in metrics:
        m.init(RunConfig())
        try:
            score = float(m.single_turn_score(sample))
        except Exception:
            score = 0.0
        results.append({"key": f"ragas_{m.name}", "score": score})
    return results


def main():
    client = Client()

    # 데이터셋(시험지) 준비 — 없으면 생성
    if not client.has_dataset(dataset_name=DATASET_NAME):
        ds = client.create_dataset(dataset_name=DATASET_NAME, description="PaiM 하이브리드 RAG 평가셋")
        client.create_examples(
            inputs=[{"question": q} for q, _ in TESTS],
            outputs=[{"reference": ref} for _, ref in TESTS],
            dataset_id=ds.id,
        )
        print(f"✅ 데이터셋 '{DATASET_NAME}' 생성 완료 ({len(TESTS)}문항)")
    else:
        print(f"ℹ️ 기존 데이터셋 '{DATASET_NAME}' 재사용")

    exp_prefix = os.getenv(
        "EVAL_EXP", f"paim-hybrid-k{qa_engine.CHROMA_K}-d{EVAL_MAXDIST}"
    )
    print(f"[설정] project=project_test_2  judge={JUDGE_MODEL}  "
          f"K={qa_engine.CHROMA_K}  MAXDIST={EVAL_MAXDIST}  "
          f"concurrency={MAX_CONCURRENCY}")
    print(f"[실험] {exp_prefix}\n병렬 평가 실행 중...")

    results = evaluate(
        predict,
        data=DATASET_NAME,
        evaluators=[ragas_evaluator],
        experiment_prefix=exp_prefix,
        max_concurrency=MAX_CONCURRENCY,
    )
    print("\n🎉 완료! LangSmith 프로젝트 'project_test_2' 에서 실험 결과를 확인하세요.")
    return results


if __name__ == "__main__":
    main()
