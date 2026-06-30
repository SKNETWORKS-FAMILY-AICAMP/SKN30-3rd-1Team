# 메모리 대시보드: MySQL에서 전체 항목 조회 후 카테고리별 요약 메트릭 + 탭 카드 뷰 렌더링.
import streamlit as st
from backend.retriever.mysql_search import search
from frontend.components.memory_card import render_card, CATEGORY_CONFIG


def render(project_id: int, project_name: str):
    """대시보드 렌더링.
    1. MySQL에서 프로젝트의 memory 항목 전체 조회
    2. 카테고리별 개수를 상단 컬러 메트릭 카드로 표시
    3. 탭(전체/결정/액션/이슈/리스크)별로 카드 리스트 렌더링
    """
    st.header(f"메모리 대시보드 — {project_name}")

    items = search(project_id)

    if not items:
        st.info("아직 업로드된 문서가 없습니다. 먼저 문서를 업로드하세요.")
        return

    counts = {cat: sum(1 for i in items if i["category"] == cat)
              for cat in ["decision", "action", "issue", "risk"]}

    # 카테고리별 색상 + 개수를 상단 4개 컬럼에 메트릭 카드로 표시
    cols = st.columns(4)
    labels = {"decision": "결정", "action": "액션", "issue": "이슈", "risk": "리스크"}
    for col, (cat, cnt) in zip(cols, counts.items()):
        cfg = CATEGORY_CONFIG[cat]
        col.markdown(
            f'<div style="background:{cfg["bg"]};border-left:4px solid {cfg["color"]};'
            f'padding:12px;border-radius:8px;text-align:center;">'
            f'<div style="font-size:24px;font-weight:700;color:{cfg["color"]};">{cnt}</div>'
            f'<div style="font-size:13px;color:#555;">{labels[cat]}</div></div>',
            unsafe_allow_html=True,
        )

    st.divider()

    # 탭별 필터링: cat_key=None이면 전체 표시
    tab_labels = ["전체"] + [labels[c] for c in ["decision", "action", "issue", "risk"]]
    tabs = st.tabs(tab_labels)

    cat_keys = [None, "decision", "action", "issue", "risk"]
    for tab, cat_key in zip(tabs, cat_keys):
        with tab:
            filtered = items if cat_key is None else [i for i in items if i["category"] == cat_key]
            if not filtered:
                st.info("항목이 없습니다.")
            for item in filtered:
                render_card(item)
