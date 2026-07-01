# RAG 성능 평가 (RAGAS, 로컬) — 우리 backend 하이브리드 검색을 평가한다.
#
# 목적: 성능 점수를 보고 리트리버/청킹 파라미터를 튜닝하기 위한 도구.
#   - 리트리버 파라미터는 환경변수로 바꿔가며 재실행 → 즉시 비교
#       예)  EVAL_K=3 EVAL_MAXDIST=1.1  로 실행
#   - 청킹 파라미터(ingestor의 CHUNK_SIZE)는 "재적재"가 필요하므로 이 파일 범위 밖.
#
# 기본은 리트리버 튜닝용 경량 모드(정밀도+재현율 2지표, 병렬).
#   EVAL_FULL=1  → 5지표 전체(최종 보고용, 느림)
#   EVAL_JUDGE=gpt-4o  → 채점 모델 상향(최종 신뢰 보고용)
#
# ⚠️ 파일명 주의: `ragas.py` 금지 (패키지 shadowing).
# 실행(SSH 터널 켠 상태):  python backend/test/rag_eval.py

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

from openai import OpenAI
from ragas import EvaluationDataset, evaluate
from ragas.llms import llm_factory
from ragas.embeddings import embedding_factory
from ragas.run_config import RunConfig
from ragas.metrics import (
    LLMContextPrecisionWithReference,   # 검색 정밀도 (노이즈)  — 리트리버
    LLMContextRecall,                   # 검색 재현율 (누락)    — 리트리버
    Faithfulness,                       # 충실도 (환각)         — 생성기
    ResponseRelevancy,                  # 응답 적절성           — 생성기
    FactualCorrectness,                 # 사실 정확도           — 종합
)

from backend.retriever import qa_engine, mysql_search

# ── 평가 대상 & 튜닝 파라미터 (환경변수 오버라이드) ──
PROJECT_ID = int(os.getenv("EVAL_PID", "6"))
qa_engine.CHROMA_K = int(os.getenv("EVAL_K", str(qa_engine.CHROMA_K)))
qa_engine.CHROMA_MAX_DISTANCE = float(os.getenv("EVAL_MAXDIST", str(qa_engine.CHROMA_MAX_DISTANCE)))
JUDGE_MODEL = os.getenv("EVAL_JUDGE", "gpt-4o-mini")
FULL = os.getenv("EVAL_FULL", "0") == "1"
MAX_WORKERS = int(os.getenv("EVAL_WORKERS", "8"))

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


def collect(project_id: int, question: str):
    """우리 backend의 하이브리드 검색+생성을 실행해 (컨텍스트 리스트, 답변) 반환.
    ★ 버그 수정: 검색 결과를 잘리지 않은 '전체' 텍스트로 수집한다.
      (기존엔 debug의 chroma 200자 잘린 값을 써서 지표가 왜곡됐음)
    """
    # 1) MySQL 구조화 기록 — 전체 내용 (qa_engine._build_context와 동일 형식)
    category = qa_engine._extract_category(question)
    rows = mysql_search.search(project_id, category=category)
    mysql_items = [f"[{r['category']}] {r['content']} (출처: {r['source']})" for r in rows]

    # 2) ChromaDB 원문 — 전체 청크 (잘림 없음), qa_engine와 동일 파라미터/필터
    scored = qa_engine._get_vectorstore().similarity_search_with_score(
        question, k=qa_engine.CHROMA_K, filter={"project_id": project_id}
    )
    chroma_docs = [d for d, dist in scored if dist <= qa_engine.CHROMA_MAX_DISTANCE]
    chroma_items = [d.page_content for d in chroma_docs]

    # RAGAS retrieved_contexts = 검색된 개별 컨텍스트(전체)
    contexts = mysql_items + chroma_items

    # 생성 — 실제 backend와 동일하게 두 컨텍스트를 합쳐 LLM에 전달
    parts = [p for p in ["\n".join(mysql_items), "\n".join(chroma_items)] if p]
    full_context = "\n\n".join(parts)
    answer = qa_engine._get_chain().invoke(
        {"history": [], "context": full_context, "question": question}
    )
    return contexts, answer


def main():
    mode = "전체(5지표)" if FULL else "경량(정밀도+재현율)"
    print(f"[설정] PID={PROJECT_ID}  K={qa_engine.CHROMA_K}  MAXDIST={qa_engine.CHROMA_MAX_DISTANCE}  "
          f"judge={JUDGE_MODEL}  mode={mode}  workers={MAX_WORKERS}")

    client = OpenAI()
    ragas_llm = llm_factory(JUDGE_MODEL, client=client)

    # 평가 데이터 수집 (우리 backend 실행) — 순차(빠름), MySQL+Chroma+생성
    rows = []
    for i, (q, ref) in enumerate(TESTS, 1):
        contexts, answer = collect(PROJECT_ID, q)
        rows.append({
            "user_input": q,
            "retrieved_contexts": contexts,
            "response": answer,
            "reference": ref,
        })
        print(f"  ({i}/{len(TESTS)}) 수집: {q[:26]} … (컨텍스트 {len(contexts)}개)")

    dataset = EvaluationDataset.from_list(rows)

    # 지표 — 기본은 리트리버 2개, EVAL_FULL이면 5개 전체
    metrics = [
        LLMContextPrecisionWithReference(llm=ragas_llm),
        LLMContextRecall(llm=ragas_llm),
    ]
    if FULL:
        ragas_emb = embedding_factory(model="text-embedding-3-small")
        metrics += [
            Faithfulness(llm=ragas_llm),
            ResponseRelevancy(llm=ragas_llm, embeddings=ragas_emb),
            FactualCorrectness(llm=ragas_llm),
        ]

    print(f"\nRAGAS 평가 실행 (병렬 max_workers={MAX_WORKERS})...")
    result = evaluate(
        dataset=dataset,
        metrics=metrics,
        run_config=RunConfig(max_workers=MAX_WORKERS),
    )
    print("\n===== RAGAS 결과 =====")
    print(result)

    df = result.to_pandas()
    tag = "full" if FULL else "lite"
    out = _HERE.parent / f"rag_eval_{tag}_k{qa_engine.CHROMA_K}_d{qa_engine.CHROMA_MAX_DISTANCE}.csv"
    df.to_csv(out, index=False, encoding="utf-8-sig")
    print(f"\n상세 저장: {out.name}")


if __name__ == "__main__":
    main()
