# 추출된 MemoryItem 목록을 MySQL(구조화)과 ChromaDB(벡터) 두 저장소에 적재하는 모듈.
# MySQL은 카테고리별 검색, ChromaDB는 의미 유사도 검색에 사용.
import re
from typing import List, Optional
from .models import MemoryItem
from ..db.mysql import get_connection
from ..db.chroma import get_collection

CHUNK_SIZE = 600  # ChromaDB 적재 시 원문 청크 크기 (문자 수)
CHUNK_OVERLAP = 150


def _normalize_date(date_str: Optional[str]) -> Optional[str]:
    """LLM이 반환한 다양한 날짜 형식을 MySQL DATE 타입이 수용하는 YYYY-MM-DD로 통일.
    유효하지 않은 날짜(예: 2026-02-30)는 None 반환하여 DB INSERT 오류를 방지.
    """
    from datetime import datetime as _dt
    if not date_str:
        return None

    def _validated(y: str, mo: str, d: str) -> Optional[str]:
        try:
            _dt(int(y), int(mo), int(d))
            return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
        except ValueError:
            return None

    # 이미 YYYY-MM-DD인 경우 (LLM이 올바르게 반환한 경우)
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', date_str)
    if m:
        return _validated(*m.groups())
    # 한국어 형식: 2026년 6월 2일
    m = re.match(r'(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일', date_str)
    if m:
        return _validated(*m.groups())
    # 슬래시/점 구분자: YYYY/MM/DD 또는 YYYY.MM.DD
    m = re.match(r'(\d{4})[./](\d{1,2})[./](\d{1,2})', date_str)
    if m:
        return _validated(*m.groups())
    return None


# --- [수정] 단순 글자 수 슬라이싱 대신 문장 경계를 고려한 오버랩 분할로 변경 ---
def _split_text(text: str) -> List[str]:
    """원문 텍스트를 CHUNK_SIZE 단위로 분할. ChromaDB는 짧은 청크가 검색 정확도가 더 높음."""
    if len(text) <= CHUNK_SIZE:
        return [text.strip()] if text.strip() else []

    # 마침표, 줄바꿈 등으로 임시 분할
    sentences = re.split(r'(?<=[.\n])\s*', text)
    chunks = []
    current_chunk = ""

    for sentence in sentences:
        if not sentence.strip():
            continue
        
        # 현재 청크에 문장을 더했을 때 CHUNK_SIZE를 넘지 않으면 추가
        if len(current_chunk) + len(sentence) <= CHUNK_SIZE:
            current_chunk += " " + sentence if current_chunk else sentence
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            
            # 오버랩(CHUNK_OVERLAP)을 위해 이전 청크의 뒷부분 일부를 가져와서 새 청크 시작
            overlap_text = current_chunk[-CHUNK_OVERLAP:] if len(current_chunk) > CHUNK_OVERLAP else current_chunk
            # 단어 중간이 잘리는 것을 방지하기 위해 공백 기준으로 정돈
            if " " in overlap_text:
                overlap_text = overlap_text[overlap_text.find(" ")+1:]
                
            current_chunk = overlap_text + " " + sentence

    if current_chunk.strip():
        chunks.append(current_chunk.strip())
        
    return chunks


def ingest(
    project_id: int,
    doc_id: int,
    items: List[MemoryItem],
    raw_text: str,
    source: str,
    date: str,
    doc_type: str,
):
    """추출 결과를 두 DB에 순서대로 저장.
    1단계: MySQL — items 각각을 memory 테이블에 INSERT (실패 시 rollback)
    2단계: ChromaDB — 원문(raw_text)을 청크로 분할해 벡터 임베딩으로 저장
    """
    chunks = _split_text(raw_text)

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            for item in items:
                cursor.execute(
                    """
                    INSERT INTO memory
                        (project_id, doc_id, category, content,
                         reason, topic, owner, date, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        project_id, doc_id,
                        item.category, item.content,
                        item.reason, item.topic,
                        item.owner, _normalize_date(item.date),  # 날짜 정규화 후 저장
                        source,
                    ),
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    if not chunks:
        return

    # ChromaDB에 원문 청크 저장 (벡터 임베딩은 ChromaDB가 자동 처리)
    # id 형식: "doc{doc_id}_chunk{i}" — 재업로드 시 같은 id로 덮어쓰기됨
    collection = get_collection()

    metadatas = [{
        "project_id": project_id,
        "doc_id": doc_id,
        "doc_type": doc_type,
        "source": source,
        "date": date
    } for _ in range(len(chunks))]
    
    collection.add(
        ids=[f"doc{doc_id}_chunk{i}" for i in range(len(chunks))],
        documents=chunks,
        metadatas=[{
            "project_id": project_id,
            "doc_id":     doc_id,
            "source":     source,
            "date":       date,
            "doc_type":   doc_type,
        } for _ in chunks],
    )