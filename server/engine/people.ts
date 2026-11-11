// 할 일 담당자 찾기: 할 일 이름이 아니라 '맡는 직무'와 그 직무가 책임지는 대상으로 찾는다 (데이터셋마다 할 일 이름이 달라도 된다)
//   직무 이름은 HD현대 기준 (코드는 그대로): control = 생산관리, pm = 계약관리, purchase = 구매조달, warranty = 보증
//   설계 → 부품(도면) 담당 · 구매조달 → 자재 담당 · 생산 → 블록 담당 · 협력사 관리 → 협력사 창구
//   계약관리 → 호선 담당(없으면 시리즈 담당) · 생산관리 → 주관자 · 품질 → 검사 작업장 반장 · 보증 → 조직표의 보증 담당
//   그 밖의 직무(법무, 원가 …)는 부서장이 맡는다. 찾는 대상이 있는데 담당이 없으면 부서장 + '담당자 미지정'
import type { Row } from "./basics.js"
import { activeOn, type World } from "./world.js"

export type Owner = { employeeId: string | null; name: string; department: string; unassigned: boolean; via: string }
export type OwnerHint = { partIds?: string[]; materialIds?: string[]; blockIds?: string[]; builderIds?: string[]; hullId?: string | null }

const person = (w: World, e: Row | undefined, via: string, unassigned = false): Owner => ({
  employeeId: e?.employee_id ?? null,
  name: e?.name ?? "담당자 없음",
  department: e ? (w.department.get(e.department_code)?.name_ko ?? e.department_code) : "",
  unassigned: unassigned || !e,
  via,
})

export function headOf(w: World, role: string) {
  const people = w.employees.filter((e) => e.role_code === role && e.active)
  return people.find((e) => e.is_department_head) ?? people[0]
}

function responsible(w: World, type: string, ids: string[], day: string) {
  for (const id of ids) {
    const rows = activeOn(w.responsibilities.get(`${type}:${id}`) ?? [], day)
    const e = rows.map((r) => w.employee.get(r.employee_id)).find((x) => x?.active)
    if (e) return e
  }
  return undefined
}

export function chairOf(w: World, day: string) {
  const row = activeOn(
    w.assignments.filter((a) => a.assignment_role === "chair" && !a.hull_id),
    day,
  )[0]
  return row ? person(w, w.employee.get(row.employee_id), "프로젝트 조직표 (주관자)") : person(w, headOf(w, "control"), "생산관리 부서장 · 주관자 미지정", true)
}

// 이번 회의(변경 · 회의일)의 주관자: 위임 기록이 있으면 받은 사람, 없으면 조직표의 주관자
export function actingChairOf(w: World, changeId: string, day: string): Owner & { delegatedFromId: string | null } {
  const d = w.seed.delegations
    .filter((x) => x.change_id === changeId && x.meeting_date === day)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .at(-1)
  // 자기에게 다시 맡기면 위임 취소
  if (!d || d.to_employee_id === d.from_employee_id) return { ...chairOf(w, day), delegatedFromId: null }
  const from = w.employee.get(d.from_employee_id)?.name ?? d.from_employee_id
  return { ...person(w, w.employee.get(d.to_employee_id), `이번 회의 위임 (${from}${d.reason ? ` · ${d.reason}` : ""})`), delegatedFromId: d.from_employee_id }
}

export function ownerFor(w: World, role: string, hint: OwnerHint, day: string): Owner {
  const fallback = (what: string) => person(w, headOf(w, role), `${w.label("role", role)} 부서장 · ${what} 담당자 미지정`, true)
  switch (role) {
    case "control":
      return chairOf(w, day)
    case "pm": {
      const pms = activeOn(
        w.assignments.filter((a) => a.assignment_role === "project_manager"),
        day,
      )
      const row = (hint.hullId && pms.find((a) => a.hull_id === hint.hullId)) || pms.find((a) => !a.hull_id)
      return row ? person(w, w.employee.get(row.employee_id), row.hull_id ? "프로젝트 조직표 (호선 계약관리)" : "프로젝트 조직표 (시리즈 계약관리)") : fallback("계약관리")
    }
    case "warranty": {
      const row = activeOn(
        w.assignments.filter((a) => a.assignment_role === "warranty_manager"),
        day,
      )[0]
      return row ? person(w, w.employee.get(row.employee_id), "프로젝트 조직표 (보증 담당)") : fallback("보증")
    }
    case "design": {
      const e = responsible(w, "part", hint.partIds ?? [], day)
      return e ? person(w, e, "PLM 도면 담당") : fallback("도면")
    }
    case "purchase": {
      const e = responsible(w, "material", hint.materialIds ?? [], day)
      return e ? person(w, e, "ERP 자재 담당") : hint.materialIds?.length ? fallback("자재") : person(w, headOf(w, role), "부서장")
    }
    case "production": {
      const e = responsible(w, "block", hint.blockIds ?? [], day)
      return e ? person(w, e, "MES 블록 담당") : fallback("블록")
    }
    case "subcon": {
      const e = (hint.builderIds ?? []).map((id) => w.employee.get(w.counterparty.get(id)?.contact_employee_id)).find(Boolean)
      return e ? person(w, e, "협력사 창구") : fallback("협력사")
    }
    case "quality": {
      const group = [...w.resourceGroup.values()].find((g) => g.role_code === "quality")
      const e = group?.foreman_employee_id ? w.employee.get(group.foreman_employee_id) : undefined
      return e ? person(w, e, "검사 작업장 반장") : fallback("검사")
    }
    default:
      return person(w, headOf(w, role), "부서장")
  }
}
