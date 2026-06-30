# 질문 키워드로 검색 경로(mysql / chroma / both)를 결정하는 규칙 기반 분류기.
# mysql: 구조화된 목록/담당자 조회 → memory 테이블 직접 검색
# chroma: 의미/배경/이유 질문 → 벡터 유사도 검색
# both: 해당 없으면 두 DB 모두 검색 (default)

# 담당자·목록·개수 등 구조화 쿼리에 적합한 키워드
MYSQL_KEYWORDS  = ["미정", "담당", "목록", "누가", "몇 개", "리스트"]
# 맥락·배경·이유 등 의미 검색에 적합한 키워드
CHROMA_KEYWORDS = ["왜", "이유", "관련", "어때", "설명", "배경"]


def classify(question: str) -> str:
    """질문에 키워드가 포함되어 있으면 해당 경로, 없으면 'both' 반환."""
    if any(k in question for k in MYSQL_KEYWORDS):
        return "mysql"
    elif any(k in question for k in CHROMA_KEYWORDS):
        return "chroma"
    else:
        return "both"
