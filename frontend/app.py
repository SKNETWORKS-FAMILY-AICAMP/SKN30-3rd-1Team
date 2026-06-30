# PaiM Streamlit 앱 진입점.
# 사이드바: 프로젝트 CRUD + 선택(최대 5개 표시 후 expand) + 페이지 네비게이션
# 메인 영역: 선택된 페이지 뷰 렌더링 (upload / dashboard / chat / timeline)
# 주의: frontend/views/ 디렉토리는 pages/가 아닌 views/로 명명 — Streamlit의 자동 멀티페이지 탐지 방지
import streamlit as st
from backend.db.mysql import get_connection
from frontend.views import upload, dashboard, chat, timeline

st.set_page_config(
    page_title="PaiM",
    page_icon="🧠",
    layout="wide",
)

# 사이드바 버튼을 전체 너비로 표시하는 커스텀 CSS.
# .nav-btn: 기본 스타일, .nav-btn-active: 현재 선택 항목 하이라이트
st.markdown("""
<style>
div[data-testid="stSidebarContent"] .nav-btn button {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: inherit;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.9rem;
}
div[data-testid="stSidebarContent"] .nav-btn button:hover {
    background: rgba(255,255,255,0.08);
}
div[data-testid="stSidebarContent"] .nav-btn-active button {
    background: rgba(255,255,255,0.15) !important;
    font-weight: 600;
}
</style>
""", unsafe_allow_html=True)

# 사이드바 하단 페이지 네비게이션 정의
PAGES = [
    ("📤", "문서 업로드"),
    ("📊", "메모리 대시보드"),
    ("💬", "Q&A 채팅"),
    ("📅", "타임라인"),
]


def get_projects() -> list:
    """MySQL projects 테이블에서 전체 프로젝트 목록 조회 (최신순)."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id, name FROM projects ORDER BY created_at DESC")
            return cursor.fetchall()
    finally:
        conn.close()


def create_project(name: str) -> int:
    """새 프로젝트를 MySQL에 INSERT하고 생성된 id 반환."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("INSERT INTO projects (name) VALUES (%s)", (name,))
            project_id = cursor.lastrowid
        conn.commit()
        return project_id
    finally:
        conn.close()


def sidebar():
    """사이드바 렌더링. 반환: (selected_project_id, project_name, current_page).
    프로젝트가 없으면 (None, "", "문서 업로드") 반환.

    프로젝트 목록은 최대 PROJECT_COLLAPSE(5)개까지만 표시하고,
    더 있을 경우 '▼ N개 더 보기' 버튼으로 expand.
    """
    st.sidebar.title("🧠 PaiM")
    st.sidebar.divider()

    # 프로젝트 생성 — expander 안에서 이름 입력 후 생성
    with st.sidebar.expander("＋ 새 프로젝트"):
        new_name = st.text_input("프로젝트명", key="new_project_name")
        if st.button("생성", key="create_project"):
            if new_name.strip():
                pid = create_project(new_name.strip())
                st.session_state.selected_project_id = pid
                st.rerun()
            else:
                st.warning("프로젝트명을 입력하세요.")

    projects = get_projects()
    if not projects:
        st.sidebar.info("프로젝트가 없습니다.")
        return None, "", "문서 업로드"

    # 프로젝트 선택 — 커스텀 전체너비 버튼 (기본 radio 대신 사용)
    PROJECT_COLLAPSE = 5  # 기본 표시 최대 개수

    if "selected_project_id" not in st.session_state:
        st.session_state.selected_project_id = projects[0]["id"]
    if "projects_expanded" not in st.session_state:
        st.session_state.projects_expanded = False

    selected_id = st.session_state.selected_project_id
    # 선택된 프로젝트가 목록에 없으면 첫 번째로 fallback
    if not any(p["id"] == selected_id for p in projects):
        selected_id = projects[0]["id"]
        st.session_state.selected_project_id = selected_id

    visible = projects if st.session_state.projects_expanded else projects[:PROJECT_COLLAPSE]

    for p in visible:
        is_active = p["id"] == selected_id
        css_class = "nav-btn nav-btn-active" if is_active else "nav-btn"
        with st.sidebar.container():
            st.markdown(f'<div class="{css_class}">', unsafe_allow_html=True)
            if st.button(p["name"], key=f"proj_{p['id']}", use_container_width=True):
                st.session_state.selected_project_id = p["id"]
                st.rerun()
            st.markdown('</div>', unsafe_allow_html=True)

    # PROJECT_COLLAPSE 초과 시 더 보기/접기 토글 버튼 표시
    if len(projects) > PROJECT_COLLAPSE:
        if st.session_state.projects_expanded:
            if st.sidebar.button("▲ 접기", key="proj_collapse", use_container_width=True):
                st.session_state.projects_expanded = False
                st.rerun()
        else:
            remaining = len(projects) - PROJECT_COLLAPSE
            if st.sidebar.button(f"▼ {remaining}개 더 보기", key="proj_expand", use_container_width=True):
                st.session_state.projects_expanded = True
                st.rerun()

    selected_project = next(p for p in projects if p["id"] == selected_id)

    st.sidebar.divider()

    # 페이지 네비게이션 — 커스텀 전체너비 버튼 (active 항목 하이라이트)
    if "current_page" not in st.session_state:
        st.session_state.current_page = "문서 업로드"

    for icon, label in PAGES:
        is_active = st.session_state.current_page == label
        css_class = "nav-btn nav-btn-active" if is_active else "nav-btn"
        with st.sidebar.container():
            st.markdown(f'<div class="{css_class}">', unsafe_allow_html=True)
            if st.button(f"{icon}  {label}", key=f"nav_{label}", use_container_width=True):
                st.session_state.current_page = label
                st.rerun()
            st.markdown('</div>', unsafe_allow_html=True)

    return selected_id, selected_project["name"], st.session_state.current_page


# 앱 진입점: sidebar()에서 선택 상태를 받아 해당 페이지 뷰를 렌더링
result = sidebar()
if result[0] is None:
    st.title("🧠 PaiM")
    st.info("왼쪽 사이드바에서 프로젝트를 먼저 생성하세요.")
else:
    project_id, project_name, page = result

    if page == "문서 업로드":
        upload.render(project_id, project_name)
    elif page == "메모리 대시보드":
        dashboard.render(project_id, project_name)
    elif page == "Q&A 채팅":
        chat.render(project_id, project_name)
    elif page == "타임라인":
        timeline.render(project_id, project_name)
