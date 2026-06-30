# 타임라인 페이지: memory 항목을 날짜순으로 정렬해 수직 타임라인 HTML로 표시.
# 상단 세그먼트 컨트롤로 카테고리 필터 적용 가능.
import streamlit as st
from backend.retriever.mysql_search import search
from frontend.components.timeline_view import render_timeline
from frontend.components.memory_card import CATEGORY_CONFIG


def render(project_id: int, project_name: str):
    """타임라인 페이지 렌더링.
    1. MySQL에서 프로젝트 항목 전체 조회
    2. 세그먼트 컨트롤로 카테고리 필터 선택 (전체/결정/액션/이슈/리스크)
    3. 필터된 항목을 render_timeline()으로 날짜순 그룹 타임라인 렌더링
    """
    st.header(f"타임라인 — {project_name}")

    items = search(project_id)

    if not items:
        st.info("아직 업로드된 문서가 없습니다.")
        return

    labels = {"decision": "결정", "action": "액션", "issue": "이슈", "risk": "리스크"}
    options = ["전체"] + list(labels.values())
    # 한글 레이블 → 영어 카테고리 키 역매핑 (필터 적용 시 사용)
    cat_map = {v: k for k, v in labels.items()}

    selected = st.segmented_control(
        "카테고리 필터",
        options=options,
        default="전체",
    )

    if selected and selected != "전체":
        cat_key = cat_map[selected]
        filtered = [i for i in items if i["category"] == cat_key]
    else:
        filtered = items

    st.caption(f"총 {len(filtered)}개 항목")
    render_timeline(filtered)
