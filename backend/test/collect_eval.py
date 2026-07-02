# 평가 데이터 수집 — 실서비스 경로(_build_context + 생성)를 그대로 실행해 JSON 저장.
# RAGAS 채점은 별도 Python 3.12 venv에서 이 JSON을 읽어 수행(ragas 0.2.x가 3.14 비호환).
# 실행(터널 ON): python backend/test/collect_eval.py
import json
import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[2]
sys.path.insert(0, str(_REPO))
os.environ.setdefault("CHROMA_PERSIST_DIR", str(_REPO / ".chroma"))
from dotenv import dotenv_values
os.environ.update({k: v for k, v in dotenv_values(str(_REPO / ".env")).items() if v is not None})

from backend.retriever import qa_engine

PROJECT_ID = int(os.getenv("EVAL_PID", "4"))

# 4개 질문 (지표별 부하 커버: decision나열 / action나열 / 인과추론 / 보안결정)
TESTS = [
    ("이 프로젝트에서 결정된 주요 사항들을 나열해줘",
     "감마 인프라를 구형 RTX A6000 배치 아키텍처로 변경, Unsloth 4비트 양자화+가우시안 청킹으로 VRAM 병목 해결, 알파-베타 멀티테넌시 데이터 격리 확인, 이정재 수석이 6/20까지 가우시안 임베딩 최적화 문서 업로드하기로 결정."),
    ("액션 아이템(할 일) 목록을 알려줘",
     "가우시안 임베딩 최적화 명세서 6/20 업로드(지연 시 6/26 강제), 정답셋 취합·공유 6/16, 간편 비밀번호 암호화 모듈 API 6/25, 금융위 가이드라인 검토 보고서 6/20."),
    ("감마 프로젝트가 왜 구형 하드웨어를 쓰게 됐어?",
     "하드웨어 구매 예산이 70% 삭감되어 고가 서버 구매가 반려됐고, 사내 유휴 구형 RTX A6000 배치 아키텍처로 전환했기 때문."),
    ("보안 때문에 어떤 결정을 했고 그 이유는 뭐야?",
     "민감 데이터 외부 유출 우려(PII·보안심의)로 외부 API/클라우드 반려, RunPod 프라이빗+오픈소스 LLM 자체 구축 결정. 멀티테넌시 데이터 격리도 검증."),
]


def collect(question):
    context, _, debug = qa_engine._build_context(PROJECT_ID, question)
    contexts = [f"[{r['category']}] {r['content']}" for r in debug["mysql_rows"]]
    contexts += [c["text_full"] for c in debug["chroma_chunks"]]
    answer = qa_engine._get_chain().invoke({"history": [], "context": context, "question": question})
    return contexts, answer


def main():
    import time
    rows = []
    for i, (q, ref) in enumerate(TESTS, 1):
        t0 = time.time()
        contexts, answer = collect(q)
        rows.append({"user_input": q, "retrieved_contexts": contexts,
                     "response": answer, "reference": ref})
        print(f"  ({i}/{len(TESTS)}) {q[:24]} … ctx={len(contexts)} ({time.time()-t0:.1f}s)")
    out = _HERE.parent / "eval_collected.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"저장: {out}")


if __name__ == "__main__":
    main()
