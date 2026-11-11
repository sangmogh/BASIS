// AI ① 변경 읽기 자리. AI 결과가 없을 때(직접 등록) 변경 글에서 규칙으로 다섯 기준 중 넷을 읽는다
import type { Change, Features } from "../data/types.js"

const PARTS: Array<[string, string, string]> = [
  ["서포트", "배관 서포트", "배관"],
  ["방화문", "방화문", "의장"],
  ["보강재", "보강재", "선체"],
  ["맨홀", "맨홀", "선체"],
  ["덕트", "덕트 지지대", "의장"],
  ["배관", "배관", "배관"],
]

export function readFeatures(change: Change): Features {
  if (change.features) return change.features
  const text = `${change.title} ${change.member ?? ""} ${change.v1 ?? ""} ${change.v2 ?? ""}`
  const part = PARTS.find(([key]) => text.includes(key))
  const types: string[] = []
  if (/두께|치수|간격|\d+t\b|mm/.test(text)) types.push("두께·치수 변경")
  if (/위치|이동|프레임/.test(text)) types.push("위치 이동")
  if (/등급|사양/.test(text)) types.push("등급·사양 변경")
  if (change.material) types.push("자재 교체")
  const zone = change.block.startsWith("A")
    ? "거주구 (A)"
    : change.block.startsWith("E2")
      ? "화물창 배관 (E)"
      : change.block.startsWith("E")
        ? "화물창 (E)"
        : `${change.block} 블록`
  return { part: part?.[1] ?? change.member ?? "-", trade: part?.[2] ?? "-", types, zone }
}

// 영향 범위 자동 분류 (기능명세 0-1 · 2-1-c): PLM 변경 요청이 들어오면 자재(BOM) · 형상이 바뀌는지로 나눈다.
// 자재나 형상이 바뀌면 생산 · 구매까지 가서 회의에 올리고, 도면 표기 · 번호만 바뀌면 설계 안에서 끝나 알림만 보낸다.
// 계약(선주) · 규정(선급)까지 가는지는 사유로 붙인다 (scopeOf)
export function classifyBoundary(change: Change): { boundary: Change["boundary"]; why: string } {
  const bom = change.bom?.length ?? 0
  if (bom) return { boundary: "production", why: `부품 목록(BOM) ${bom}건이 바뀜` }
  if (change.material) return { boundary: "production", why: `자재 ${change.material.item}이(가) 바뀜` }
  const note = change.drawing?.note ?? ""
  const text = `${change.v1 ?? ""} ${change.v2 ?? ""} ${note}`
  if (/형상 변경 없음/.test(text) || (/표기|번호|기호/.test(note) && !/위치|두께|간격|크기|치수 변경/.test(note)))
    return { boundary: "design", why: "도면 표기 · 번호만 바뀌고 형상 · 자재는 그대로" }
  if (change.v1 && change.v2 && change.v1 !== change.v2) return { boundary: "production", why: `형상이 바뀜 (${change.v1} → ${change.v2})` }
  return { boundary: "production", why: "형상 · 자재 변경 여부를 알 수 없어 회의에 올림" }
}
