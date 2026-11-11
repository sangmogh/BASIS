// Claude에 보낼 지시문. 사례 목록처럼 바뀌지 않는 부분은 system에 두어 캐시가 되게 하고,
// 변경 건과 엔진이 계산한 사실은 user에 둔다. 날짜 · 숫자는 주어진 사실만 쓰게 한다.
import type { CaseRecord, Change } from "../data/types.js"
import { type Context, formatShort, meetingDeadline, simulate, timingDistribution } from "../engine/index.js"
import { CHANGE_TYPES, PARTIES, TRADES, ZONES } from "./analysis.js"

export function systemPrompt(cases: CaseRecord[]) {
  return `당신은 조선소 설계변경 회의 대시보드 BASIS의 분석 담당입니다. 회의에 올라온 설계변경 한 건을 읽고 세 가지를 냅니다.

1. features: 변경의 특징 (다섯 기준 중 넷. "언제"는 시스템이 블록 일정으로 계산하므로 내지 않습니다)
   - part: 바뀌는 부재 이름을 짧게 (예: 배관 서포트, 방화문, 보강재)
   - trade: 공종. ${TRADES.join(" / ")} 중 하나
   - types: 변경 유형. ${CHANGE_TYPES.join(" / ")} 중 해당하는 것 모두
   - zone: 구역. ${ZONES.join(" / ")} 중 하나
2. similar: 아래 과거 사례 중 이번 변경과 비슷한 사례 최대 3건. 비슷한 정도가 높은 순으로
   - 비슷함의 기준: 같은 부재(가장 중요) · 같은 변경 유형 · 같은 구역 · 같은 사유 · 같은 반영 시점. 공종만 같은 것은 약한 근거입니다
   - 두 가지 이하만 겹치는 사례는 넣지 마세요. 비슷한 사례가 없으면 빈 배열이 맞습니다. 억지로 채우지 마세요
   - why: 겹치는 기준을 짧은 칩 문구로 (예: "같은 부재", "두께·치수 변경", "같은 구역", "선주 요청", "블록 완성 시점")
   - takeaway: "이번에 참고할 점". 그 사례의 교훈을 이번 변경의 사실(호선 · 블록 · 자재 재고 · 조달 기간 · 처리)에 맞춰 다시 쓴 1~2문장, 해요체
3. stakeholders: 이 변경에 엮여야 할 외부 · 관련 담당. ${PARTIES.join(" / ")} 중에서
   - reason: 왜 엮이는지 한 문장 (예: "선주 요청 변경. 사양 · 추가 비용 확인 필요")
   - cases: 근거가 된 과거 사례 번호 (없으면 빈 배열)
   - 설계 안에서 끝나는 변경이면 빈 배열

규칙
- 날짜, 일수, 척 수는 아래 "계산된 사실"에 있는 값만 씁니다. 새로 추정하거나 지어내지 않습니다
- 사례 번호는 목록에 있는 것만 씁니다
- 계약 조항처럼 사람이 확인해야 하는 판단은 "(확인 필요)"를 붙입니다

과거 사례 (${cases.length}건)
${cases
  .map((c) =>
    JSON.stringify({
      code: c.code,
      title: c.title,
      member: c.member,
      trade: c.trade,
      types: c.types,
      area: c.area,
      reason: c.reason,
      timing: c.timing,
      result: c.result,
      maxDelay: c.maxDelay,
      depts: c.execution.map((e) => `${e.dept} ${e.days}일`).join(", "),
      participants: c.participants?.map((p) => p.dept).join(", "),
      problem: c.problem,
      lesson: c.lesson,
    }),
  )
  .join("\n")}`
}

export function userPrompt(ctx: Context, change: Change) {
  // 이미 결정된 변경은 결정 당시의 목표일 · 처리를 사실로 준다
  const d = change.decision
  const red = meetingDeadline(ctx, change).red // 우선 검토안이 유지되는 마지막 반영일 (화면의 빨간 날짜와 같음)
  const sim = d ? simulate(ctx, change, d.target, { prepDays: d.prepDays, overrides: d.overrides, today: d.decidedOn }) : simulate(ctx, change, red)
  const facts = [
    `오늘: ${ctx.series.today}`,
    `오늘 기준 호선별 반영 시점: ${timingDistribution(ctx, change)}`,
    d
      ? `이미 결정됨: ${formatShort(d.decidedOn)} 회의에서 현장 반영 목표 ${formatShort(d.target)}로 결정 (${d.baseline} 기준선)`
      : `빨간 날짜(지금 결과가 유지되는 마지막 현장 반영일): ${formatShort(red)}`,
    `${d ? "결정한 목표일의" : "그때"} 호선별 처리: ${sim.rows.map((r) => `${r.vessel.order} ${r.handling}${r.delay ? ` (인도 +${r.delay}일)` : ""}`).join(", ")}`,
    ...sim.rows.filter((r) => r.block.partner).map((r) => `${r.vessel.order} ${change.block} 블록은 협력사 ${r.block.partner}가 만듦`),
    change.material
      ? `새 자재: ${change.material.item}, 재고 ${change.material.stock}척분, 조달 ${change.material.leadTime}일${change.material.old ? `, 기존 ${change.material.old.item} ${change.material.old.open}척분 미입고` : ""}`
      : "바뀌는 자재 없음",
  ]
  return `설계변경
${JSON.stringify({
  code: change.code,
  title: change.title,
  reason: change.reason,
  requester: change.requester,
  boundary: change.boundary === "design" ? "설계 안에서 끝남" : "생산·구매까지",
  block: change.block,
  member: change.member,
  v1: change.v1,
  v2: change.v2,
  ecrText: change.ecrText,
  drawing: change.drawing,
  bom: change.bom,
})}

계산된 사실
${facts.map((f) => `- ${f}`).join("\n")}`
}
