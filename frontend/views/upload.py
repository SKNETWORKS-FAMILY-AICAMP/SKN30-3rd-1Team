# 문서 업로드 페이지: 파일 또는 텍스트 입력 → LLM 추출 → MySQL/ChromaDB 저장.
# 멀티파일 업로드를 지원하며, 일부 청크 추출 실패 시 PartialExtractionError로 처리.
import io
import re
import pypdf
import streamlit as st
from datetime import date as date_type, datetime
from backend.pipeline.extractor import extract, PartialExtractionError
from backend.pipeline.ingestor import ingest
from backend.db.mysql import get_connection


def _extract_date(text: str) -> str:
    """문서 본문에서 날짜를 자동 추출. 컨텍스트가 강한 패턴(날짜:, Date:)을 우선 적용.
    여러 패턴을 순서대로 시도해 첫 번째 유효한 날짜를 YYYY-MM-DD로 반환.
    """
    # 문서 날짜 맥락이 강한 패턴 우선, 일반 ISO 패턴은 마지막
    patterns = [
        r'날짜\s*[:：]\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})',
        r'[Dd]ate\s*[:：]\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})',
        r'(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일',
        r'(\d{4})[-./](\d{1,2})[-./](\d{1,2})',
    ]
    for pat in patterns:
        match = re.search(pat, text)
        if match:
            y, m, d = int(match.group(1)), int(match.group(2)), int(match.group(3))
            try:
                datetime(y, m, d)
                return f"{y}-{m:02d}-{d:02d}"
            except ValueError:
                continue
    return ""


def _read_pdf(file_bytes: bytes) -> str:
    """pypdf로 PDF 텍스트 추출. 읽기 실패 시 빈 문자열 반환 (예외 전파 안 함)."""
    try:
        reader = pypdf.PdfReader(io.BytesIO(file_bytes))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception:
        return ""


def _auto_filename(doc_type: str) -> str:
    """텍스트 직접 입력 시 파일명 자동 생성. 예: meeting_20260630.md"""
    return f"{doc_type}_{date_type.today().strftime('%Y%m%d')}.md"


def _validate_date(date_str: str) -> bool:
    """날짜 문자열이 YYYY-MM-DD 형식이고 유효한 날짜인지 확인. 빈 문자열은 허용."""
    if not date_str:
        return True
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _submit(project_id: int, filename: str, doc_type: str,
            content: str, detected_date: str):
    """파일 1개 처리 흐름:
    1. documents 테이블에 메타데이터 INSERT
    2. extractor.extract() 로 LLM 추출 (PartialExtractionError 시 부분 저장)
    3. ingestor.ingest() 로 MySQL+ChromaDB 저장
    실패 시 _delete_document() 로 롤백.
    """
    if not content.strip():
        st.error("문서 내용이 비어 있습니다.")
        return
    if not _validate_date(detected_date):
        st.error("날짜는 YYYY-MM-DD 형식의 유효한 날짜여야 합니다.")
        return

    # documents 테이블에 먼저 등록해 doc_id를 확보
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO documents (project_id, filename, doc_type) VALUES (%s, %s, %s)",
                (project_id, filename, doc_type),
            )
            doc_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    partial = False
    progress = st.progress(0, text="LLM 추출 중...")

    def on_progress(done: int, total: int):
        ratio = (done / total) if total else 0
        progress.progress(ratio, text=f"LLM 추출 중... (청크 {done}/{total})")

    try:
        items = extract(content, default_source=filename, on_progress=on_progress)
    except PartialExtractionError as e:
        # 일부 청크만 실패한 경우 — 성공한 항목은 저장
        st.warning(f"일부 청크 추출 실패 ({e.failed}/{e.total}). 추출된 항목만 저장합니다.")
        items = e.items
        partial = True
    except Exception as e:
        progress.empty()
        _delete_document(doc_id)
        st.error(f"추출 실패: {e}")
        return

    try:
        progress.progress(1.0, text="저장 중...")
        for item in items:
            if not item.date:
                item.date = detected_date or None  # LLM이 날짜 미반환 시 문서 날짜로 보완
        ingest(
            project_id=project_id,
            doc_id=doc_id,
            items=items,
            raw_text=content,
            source=filename,
            date=detected_date,
            doc_type=doc_type,
        )
    except Exception as e:
        progress.empty()
        _delete_document(doc_id)
        st.error(f"저장 실패: {e}")
        return
    progress.empty()

    counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
    for item in items:
        counts[item.category] += 1

    label = "부분 업로드 완료 (일부 청크 추출 실패)" if partial else "업로드 완료"
    st.success(f"{label} (doc_id: {doc_id})")
    cols = st.columns(4)
    labels = {"decision": "결정", "action": "액션", "issue": "이슈", "risk": "리스크"}
    for col, (cat, cnt) in zip(cols, counts.items()):
        col.metric(labels[cat], cnt)


def render(project_id: int, project_name: str):
    """업로드 페이지 렌더링.
    탭 1 — 파일 업로드: 멀티파일 선택 → 파일별 진행바 표시 후 순차 처리.
    탭 2 — 텍스트 입력: 직접 붙여넣기 후 날짜 수동 보정 가능.
    """
    st.header(f"문서 업로드 — {project_name}")

    tab_file, tab_text = st.tabs(["📁 파일 업로드", "✏️ 텍스트 직접 입력"])

    with tab_file:
        uploaded_files = st.file_uploader(
            "파일을 드래그하거나 선택하세요 (여러 파일 동시 선택 가능)",
            type=["md", "txt", "pdf"],
            accept_multiple_files=True,
            label_visibility="collapsed",
        )
        doc_type = st.selectbox("문서 유형", ["meeting", "planning", "memo", "git"],
                                key="dt_file")

        if uploaded_files:
            st.caption(f"{len(uploaded_files)}개 파일 선택됨")

            if st.button("업로드 + 추출", type="primary", key="btn_file"):
                progress = st.progress(0, text="처리 중...")
                total = len(uploaded_files)

                for idx, uploaded in enumerate(uploaded_files):
                    progress.progress((idx) / total, text=f"[{idx+1}/{total}] {uploaded.name}")

                    raw = uploaded.read()
                    if uploaded.name.endswith(".pdf"):
                        content = _read_pdf(raw)
                        if not content.strip():
                            st.error(f"{uploaded.name}: PDF에서 텍스트를 읽을 수 없습니다.")
                            continue
                    else:
                        content = raw.decode("utf-8", errors="replace")

                    detected = _extract_date(content)
                    _submit(project_id, uploaded.name, doc_type, content, detected)

                progress.progress(1.0, text="완료")

    with tab_text:
        content_text = st.text_area("문서 내용", height=300,
                                    placeholder="회의록 텍스트를 붙여넣으세요...",
                                    key="content_text")
        doc_type_text = st.selectbox("문서 유형", ["meeting", "planning", "memo", "git"],
                                     key="dt_text")

        detected_text = _extract_date(content_text) if content_text else ""
        date_text = st.text_input(
            "날짜 (자동 추출 — 수정 가능)",
            value=detected_text,
            placeholder="YYYY-MM-DD",
            key="date_text",
        )

        if st.button("업로드 + 추출", type="primary", key="btn_text"):
            filename = _auto_filename(doc_type_text)
            _submit(project_id, filename, doc_type_text, content_text, date_text)


def _delete_document(doc_id: int):
    """추출/저장 실패 시 documents·memory 테이블에서 해당 doc_id 레코드 삭제 (롤백)."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM memory WHERE doc_id = %s", (doc_id,))
            cursor.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()
