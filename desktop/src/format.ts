// 현재 시각 기준으로 채팅/이벤트 목록에 보여줄 짧은 상대 시간을 만든다.
export function formatRelativeAge(createdAt: number, language: "en" | "ko" = "ko") {
  const diffMs = Math.max(0, Date.now() - createdAt);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  if (diffMs < minuteMs) {
    return language === "en" ? "now" : "방금";
  }

  if (diffMs < hourMs) {
    return language === "en" ? `${Math.floor(diffMs / minuteMs)}m` : `${Math.floor(diffMs / minuteMs)}분`;
  }

  if (diffMs < dayMs) {
    return language === "en" ? `${Math.floor(diffMs / hourMs)}h` : `${Math.floor(diffMs / hourMs)}시간`;
  }

  if (diffMs < weekMs) {
    return language === "en" ? `${Math.floor(diffMs / dayMs)}d` : `${Math.floor(diffMs / dayMs)}일`;
  }

  return language === "en" ? `${Math.floor(diffMs / weekMs)}w` : `${Math.floor(diffMs / weekMs)}주`;
}
