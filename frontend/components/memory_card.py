import html
import streamlit as st

CATEGORY_CONFIG = {
    "decision": {"label": "결정",  "color": "#1E88E5", "bg": "#E3F2FD"},
    "action":   {"label": "액션",  "color": "#43A047", "bg": "#E8F5E9"},
    "issue":    {"label": "이슈",  "color": "#FB8C00", "bg": "#FFF3E0"},
    "risk":     {"label": "리스크", "color": "#E53935", "bg": "#FFEBEE"},
}

def _e(val) -> str:
    return html.escape(str(val)) if val else ""


def render_card(item: dict):
    cfg = CATEGORY_CONFIG.get(item.get("category", ""), {
        "label": item.get("category", ""), "color": "#757575", "bg": "#F5F5F5"
    })

    badge = (
        f'<span style="background:{cfg["color"]};color:#fff;'
        f'padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;">'
        f'{cfg["label"]}</span>'
    )

    meta_parts = []
    if item.get("topic"):
        meta_parts.append(f'<b>주제</b> {_e(item["topic"])}')
    if item.get("owner"):
        meta_parts.append(f'<b>담당</b> {_e(item["owner"])}')
    if item.get("date"):
        meta_parts.append(f'<b>날짜</b> {_e(item["date"])}')
    if item.get("source"):
        meta_parts.append(f'<b>출처</b> {_e(item["source"])}')
    meta_html = " &nbsp;|&nbsp; ".join(meta_parts)

    reason_html = ""
    if item.get("reason"):
        reason_html = (
            f'<div style="margin-top:8px;padding:8px;background:#fff;'
            f'border-left:3px solid {cfg["color"]};border-radius:4px;'
            f'font-size:13px;color:#555;">'
            f'<b>이유</b>&nbsp; {_e(item["reason"])}</div>'
        )

    html_str = f"""
    <div style="background:{cfg["bg"]};border-radius:10px;padding:14px 16px;
                margin-bottom:10px;border-left:4px solid {cfg["color"]};">
      <div style="margin-bottom:6px;">{badge}</div>
      <div style="font-size:15px;font-weight:500;color:#212121;">
        {_e(item.get("content", ""))}
      </div>
      {reason_html}
      <div style="margin-top:8px;font-size:12px;color:#757575;">{meta_html}</div>
    </div>
    """
    st.markdown(html_str, unsafe_allow_html=True)
