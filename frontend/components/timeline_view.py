import html
import streamlit as st
from .memory_card import CATEGORY_CONFIG

def _e(val) -> str:
    return html.escape(str(val)) if val else ""


def render_timeline(items: list):
    if not items:
        st.info("타임라인에 표시할 항목이 없습니다.")
        return

    sorted_items = sorted(
        items,
        key=lambda x: (x.get("date") or "9999-99-99"),
    )

    grouped: dict = {}
    for item in sorted_items:
        date = item.get("date") or "날짜 미정"
        grouped.setdefault(date, []).append(item)

    st.markdown(
        '<div style="border-left:3px solid #BDBDBD;margin-left:16px;padding-left:0;">',
        unsafe_allow_html=True,
    )

    for date, date_items in grouped.items():
        st.markdown(
            f"""
            <div style="display:flex;align-items:center;margin-bottom:6px;margin-top:18px;">
              <div style="width:14px;height:14px;border-radius:50%;background:#616161;
                          margin-left:-8px;flex-shrink:0;"></div>
              <span style="margin-left:12px;font-size:13px;font-weight:700;color:#424242;">
                {_e(date)}
              </span>
            </div>
            """,
            unsafe_allow_html=True,
        )

        for item in date_items:
            cfg = CATEGORY_CONFIG.get(item.get("category", ""), {
                "label": item.get("category", ""), "color": "#757575", "bg": "#F5F5F5"
            })

            badge = (
                f'<span style="background:{cfg["color"]};color:#fff;'
                f'padding:1px 8px;border-radius:10px;font-size:11px;">'
                f'{cfg["label"]}</span>'
            )
            owner_html = (
                f'&nbsp;&nbsp;<span style="font-size:11px;color:#9E9E9E;">'
                f'{_e(item["owner"])}</span>'
                if item.get("owner") else ""
            )

            st.markdown(
                f"""
                <div style="margin-left:22px;margin-bottom:8px;padding:10px 14px;
                            background:{cfg["bg"]};border-radius:8px;
                            border-left:3px solid {cfg["color"]};">
                  <div style="margin-bottom:4px;">{badge}{owner_html}</div>
                  <div style="font-size:14px;color:#212121;">
                    {_e(item.get("content", ""))}
                  </div>
                  <div style="font-size:11px;color:#9E9E9E;margin-top:4px;">
                    {_e(item.get("source", ""))}
                  </div>
                </div>
                """,
                unsafe_allow_html=True,
            )

    st.markdown("</div>", unsafe_allow_html=True)
