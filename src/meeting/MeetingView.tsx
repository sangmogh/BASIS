// 설계변경 회의 화면 (?view=meeting&change=DC-021): 회의 순서 7단계
//   ① 변경 개요 → ② 진행 현황 → ③ 영향 분석 → ④ 대응안 → ⑤ 부서 검토 → ⑥ 의사결정 → ⑦ 후속 조치
//   위의 단계 막대 = 한눈에 보는 요약 (숫자 · 색 · 작은 호선 띠). 아래 = 지금 단계 하나만
//   호선 띠는 단계마다 같은 자리(1~10호선)에서 색만 바뀐다
//   색 약속: 부품 상태 = 남색 진하기(설치 > 제작 > 미착수) · 빨강/주황/초록 = 영향 큼/촉박/양호 · 파랑 = 추천 · 본인
//   화면 문구는 사무용 명사형. 숫자는 새 엔진(/api/review)의 실제 값. 날짜는 데이터셋 기준일(as_of)을 오늘로 옮겨 보인다 (clock.ts). 버튼은 아직 화면 안에서만 움직이고 저장하지 않는다
import { useEffect, useMemo, useRef, useState } from "react"
import type { Review } from "../../server/engine/review"
import { useAuth } from "../auth/AuthProvider"
import { api } from "../auth/session"
import { offsetFrom, shiftView } from "./clock"
import "./meeting.css"

type Hull = Review["strip"][number]
type Opt = Review["options"][number]
type OptHull = Opt["hulls"][number]
type Task = Review["tasks"][number]
type Tone = "danger" | "warning" | "success" | "neutral" | "primary" | "ins" | "fab" | "nst" | "svc"
type Confirm = { answer: "ok" | "not_ok"; days: number | null; reason: string }
type Decided = { option: string; state: "pending" | "done" }

// ── 표시 도우미 (날짜는 저장된 글자를 자른다: 시각 변환 없음)
const md = (d?: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "-")
const dayNum = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86400000
const between = (a: string, b: string) => Math.round(dayNum(b) - dayNum(a))
const won = (n: number) => {
  if (!n) return "0원"
  const eok = Math.floor(n / 1e8)
  const man = Math.round((n % 1e8) / 1e4)
  return `${eok ? `${eok}억` : ""}${eok && man ? " " : ""}${man ? `${man.toLocaleString("ko-KR")}만` : ""}원`
}
const wonShort = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 2).replace(/\.?0+$/, "")}억` : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString("ko-KR")}만` : `${n}원`)
const ddayText = (n: number) => (n === 0 ? "D-0" : n > 0 ? `D-${n}` : `D+${-n}`)
const partsSummary = (parts: string[]) => {
  if (!parts.length) return "도면"
  const base = [...new Set(parts.map((p) => p.replace(/\s*\(.*\)$/, "")))]
  return base.length === 1 && parts.length > 1 ? `${base[0]} ${parts.length}곳` : parts.join(" · ")
}
const missed = (m?: { days: number; extraOverrun: number; extraDeliveryDelay: number; extraLocalDelay: number; extraYardCost: number } | null) =>
  m
    ? [
        m.extraOverrun ? { label: "계약 납기", value: `${m.extraOverrun}일 초과` } : null,
        m.extraDeliveryDelay ? { label: "인도", value: `${m.extraDeliveryDelay}일 지연` } : null,
        m.extraLocalDelay ? { label: "공정", value: `${m.extraLocalDelay}일 지연` } : null,
        m.extraYardCost ? { label: "조선소 실부담", value: `+${won(m.extraYardCost)}` } : null,
      ].filter((x): x is { label: string; value: string } => !!x)
    : []
const total = (h: Hull) => h.units.installed + h.units.fabricated + h.units.notStarted
const LIFE: Record<string, string> = { in_service: "운항", construction: "건조", design: "설계", planned: "계획" }
const lifeShort = (h: Hull) => LIFE[h.lifecycle.code] ?? h.lifecycle.label
const CRITERION: Record<string, string> = { schedule: "납기", cost: "비용", production_disruption: "생산 차질", quality: "품질" }

const STEPS = [
  { no: 1, name: "변경 개요", title: "변경 개요" },
  { no: 2, name: "진행 현황", title: "호선별 진행 현황 (변경 대상 부품 기준)" },
  { no: 3, name: "영향 분석", title: "호선별 영향 분석" },
  { no: 4, name: "대응안", title: "대응안 검토" },
  { no: 5, name: "부서 검토", title: "부서별 검토 (납기 · 비용 · 생산)" },
  { no: 6, name: "의사결정", title: "의사결정" },
  { no: 7, name: "후속 조치", title: "후속 조치 현황" },
] as const

// ── 호선 띠: 1~10호선이 늘 같은 자리. 칸 색만 단계마다 바뀐다
function HullStrip({ hulls, tone, mark, size = "md" }: { hulls: Hull[]; tone: (h: Hull) => Tone; mark?: (h: Hull) => string | null; size?: "xs" | "md" }) {
  return (
    <div className={`mt-strip ${size}`} style={{ gridTemplateColumns: `repeat(${hulls.length}, 1fr)` }}>
      {hulls.map((h) => (
        <div key={h.hullId} className={`mt-strip-cell tone-${tone(h)}`} title={`${h.seq}호선`}>
          {size !== "xs" && <span className="mt-strip-no">{h.seq}</span>}
          {size !== "xs" && mark?.(h) && <span className="mt-strip-mark">{mark(h)}</span>}
        </div>
      ))}
    </div>
  )
}

// 부품 상태로 칸 색: 가장 진행된 상태 (운항 중은 따로, 부품 없으면 회색)
const stateTone = (h: Hull): Tone => (!total(h) ? "neutral" : h.lifecycle.code === "in_service" ? "svc" : h.units.installed ? "ins" : h.units.fabricated ? "fab" : "nst")

// ③ 영향: 호선마다 한 줄 (색 = 위 호선 띠와 같은 빨강 · 주황 · 초록)
//   부품 = MES 실적 · 조치 = 엔진의 호선별 처리(대응안마다 다르면 함께) · 작업 = 엔진이 그 호선에 만든 일 · 기한 = 그 호선의 준비 기한
// 엔진의 호선별 처리 코드 → 조치. 기존 부품은 보강 · 교체로 쪼개 대응안끼리 비교한다 (mixed = 보강 + 교체)
const TREAT: Record<string, string[]> = { new_spec: ["변경 도면 적용 제작"], rework: ["기존 부품 교체"], retrofit: ["기존 부품 보강"], mixed: ["기존 부품 보강", "기존 부품 교체"], post_delivery: ["인도 후 개조"], not_applicable: ["변경 적용 제외"] }
const PART_PREFIX = "기존 부품 "
const actText = (acts: string[], joiner: string) =>
  acts.length > 1 && acts.every((a) => a.startsWith(PART_PREFIX)) ? PART_PREFIX + acts.map((a) => a.slice(PART_PREFIX.length)).join(joiner) : acts.join(joiner)
const unitsText = (h: Hull) =>
  [h.units.installed && `설치 ${h.units.installed}`, h.units.fabricated && `제작 ${h.units.fabricated}`, h.units.notStarted && `미착수 ${h.units.notStarted}`].filter(Boolean).join(" · ")
function hullRows(r: Review, focus: Opt | null) {
  const today = r.dataset.asOf.slice(0, 10)
  return r.strip.map((h) => {
    const service = h.lifecycle.code === "in_service"
    // 대응안마다 이 호선의 조치. 모두 같으면 그대로, 다르면 '또는' + (대응안별 상이)
    const perOption = r.options.map((o) => [...new Set(o.hulls.filter((x) => x.hullId === h.hullId).flatMap((x) => TREAT[x.treatment] ?? [x.treatment]))].sort())
    const union = [...new Set(perOption.flat())].sort()
    const same = perOption.every((p) => p.join() === union.join())
    const act = !total(h) || !union.length ? null : same ? actText(union, " · ") : `${actText(union, " 또는 ")} (대응안별 상이)`
    // 작업: 엔진이 이 호선에 만든 일 + 운항 호선이면 '운항 호선' 조건으로 생긴 일 (어느 대응안이든)
    const work = new Map<string, { label: string; role: string }>()
    for (const o of r.options)
      for (const t of o.tasks)
        if (t.hullId ? t.hullId === h.hullId : service && total(h) > 0 && t.when === "in_service_hull")
          work.set(t.taskCode, { label: t.label.replace(/\s*·\s*\d+호선$/, ""), role: t.roleLabel })
    // 기한: 미착수 부품이 있으면 제작 착수, 제작분만 있으면 설치 착수, 설치 끝났으면 인도 전 완료 (추천 · 결정안 기준)
    const fh = focus?.hulls.find((x) => x.hullId === h.hullId)
    const due =
      !total(h) || service || !fh || fh.treatment === "not_applicable" || fh.treatment === "post_delivery"
        ? null
        : h.units.notStarted
          ? { what: "제작 착수", date: fh.needBy }
          : h.units.fabricated
            ? { what: "설치 착수", date: fh.needBy }
            : { what: "인도 전 완료", date: fh.latestAllowed }
    // 어느 대응안에서도 적용 제외면 영향 없음 (회색)
    const excluded = union.length > 0 && union.every((a) => a === "변경 적용 제외")
    return { h, tone: excluded ? ("neutral" as Tone) : problemTone(h), excluded, parts: unitsText(h), act, work: [...work.values()], due: due?.date ? { ...due, passed: due.date < today } : null }
  })
}
const problemTone = (h: Hull): Tone => (!total(h) ? "neutral" : h.lifecycle.code === "in_service" || h.units.installed ? "danger" : h.units.fabricated ? "warning" : "success")

// ④ 안마다 호선 결과 색: 납기 초과 빨강 · 여유 3일 이하 주황 · 준수 초록 · 인도 후 개조 파랑 · 해당 없음 회색
const outcomeTone = (h?: OptHull): Tone =>
  !h || h.treatment === "not_applicable" ? "neutral" : h.treatment === "post_delivery" ? "primary" : h.overrun > 0 ? "danger" : between(h.newDelivery, h.contractDate) <= 3 ? "warning" : "success"
// ④ 안마다 기존 부품을 어떻게 하나 (엔진의 호선별 처리 코드)
const PART_ACT: Record<string, string> = { rework: "교체", retrofit: "보강", mixed: "보강 및 교체", post_delivery: "인도 후 개조", new_spec: "변경 도면 적용" }
const hullRange = (list: { seq: number }[]) => {
  const seqs = list.map((x) => x.seq).sort((a, b) => a - b)
  const runs: string[] = []
  for (let i = 0; i < seqs.length; ) {
    let j = i
    while (j + 1 < seqs.length && seqs[j + 1] === seqs[j] + 1) j++
    runs.push(i === j ? `${seqs[i]}` : `${seqs[i]}–${seqs[j]}`)
    i = j + 1
  }
  return `${runs.join(" · ")}호선`
}
// 같은 처리끼리 호선을 묶어 "2–3호선 보강, 4호선 보강 및 교체"
const byTreatment = (hulls: Hull[], label: (h: Hull) => string, joiner: string) => {
  const groups = new Map<string, Hull[]>()
  for (const h of hulls) groups.set(label(h), [...(groups.get(label(h)) ?? []), h])
  return [...groups].map(([l, hs]) => `${hullRange(hs)} ${l}`).join(joiner)
}
const LETTER_NAME: Record<string, string> ={ normal: "일반 조달", expedite: "긴급 조달", retrofit: "기존 부품 보강" }

// ⑤ 부서(직무)별 검토 상태
function teamsOf(tasks: Task[], local: Record<string, Confirm>) {
  const answerOf = (t: Task) => local[`${t.taskCode}|${t.hullId ?? ""}`]?.answer ?? (t.confirmation?.answer as "ok" | "not_ok" | undefined)
  const map = new Map<string, Task[]>()
  for (const t of tasks) map.set(t.roleLabel, [...(map.get(t.roleLabel) ?? []), t])
  return [...map].map(([team, list]) => {
    const answers = list.map(answerOf)
    return {
      team,
      tasks: list,
      status: answers.includes("not_ok") ? ("not_ok" as const) : answers.some((a) => !a) ? ("wait" as const) : ("ok" as const),
      owners: [...new Set(list.map((t) => t.owner.name))],
      ownerIds: new Set(list.map((t) => t.owner.employeeId)),
      last: list.map((t) => t.finish).sort().at(-1) ?? null,
      tight: list.filter((t) => t.flag === "tight").length,
      short: list.filter((t) => t.flag === "short").length,
      answerOf,
    }
  })
}
const STATE_LABEL = { ok: "가능", not_ok: "불가", wait: "미확인" } as const

// 한 번 받은 검토는 기억해 두고 다시 열 때 바로 보여 준 뒤 새로 받아 바꾼다
const reviewCache = new Map<string, Review>()

export default function MeetingView({ dataset, change, back }: { dataset: string; change: string; back?: () => void }) {
  const { user } = useAuth()
  const [r, setR] = useState<Review | null>(() => reviewCache.get(`${dataset}/${change}`) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(() => {
    const s = Number(new URLSearchParams(window.location.search).get("step"))
    return s >= 1 && s <= 7 ? s : 1
  })
  // 팀 확인 · 결정 · 결재는 서버 기록(/api/records, KV)에 남겨 같은 변경을 연 모든 화면이 함께 본다
  //   local = 보내는 중인 팀 확인만 (누르자마자 보이게). 서버 검토 자료가 새로 오면 다 보낸 것은 지운다
  const [local, setLocal] = useState<Record<string, Confirm>>({})
  const sending = useRef(new Set<string>())
  const [reload, setReload] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false) // 결정 · 결재를 쓴 뒤 새 검토 자료가 올 때까지 버튼을 잠가 둔다 (두 번 누르기 방지)
  const [saveError, setSaveError] = useState<string | null>(null)
  // 우선순위 바꿔 보기: null = 데이터 기준(선주 회신 · 기본 순서). 바꾸면 엔진이 그 순서로 다시 계산 (계약 납기 관문은 늘 먼저)
  const [priority, setPriority] = useState<string[] | null>(() => {
    const p = new URLSearchParams(window.location.search).get("priority")?.split(",").filter((c) => c in CRITERION)
    return p?.length ? p : null
  })
  const recLetter = (x: Review | null) => x?.options.find((o) => o.recommended)?.letter ?? null
  const [baseRec, setBaseRec] = useState<string | null>(() => recLetter(reviewCache.get(`${dataset}/${change}`) ?? null))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const key = `${dataset}/${change}${priority ? `?priority=${priority.join(",")}` : ""}`
    const cached = reviewCache.get(key)
    if (cached) setR(cached)
    let alive = true // 빠르게 여러 번 바꿔도 마지막 요청만 반영
    setBusy(true)
    api(`/api/review?dataset=${dataset}&change=${change}${priority ? `&priority=${priority.join(",")}` : ""}`)
      .then((res) => res.json())
      .then((j: { review?: Review; error?: string }) => {
        if (!alive) return
        if (j.review) {
          const view = shiftView(j.review, offsetFrom(j.review.dataset.asOf))
          reviewCache.set(key, view)
          setR(view)
          if (!priority) setBaseRec(recLetter(view))
          setLocal((l) => Object.fromEntries(Object.entries(l).filter(([k]) => sending.current.has(k))))
        } else setError(j.error ?? "검토 자료 조회 실패")
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => {
        if (!alive) return
        setBusy(false)
        if (savingRef.current) {
          savingRef.current = false
          setSaving(false)
        }
      })
    return () => {
      alive = false
    }
  }, [dataset, change, priority, reload])
  // 서버 기록이 바뀌었으면(다른 화면에서 확인 · 결정 · 결재) 검토 자료를 다시 받는다
  const refresh = () => {
    for (const k of [...reviewCache.keys()]) if (k === `${dataset}/${change}` || k.startsWith(`${dataset}/${change}?`)) reviewCache.delete(k)
    setReload((n) => n + 1)
  }
  const versionRef = useRef<number | null>(null)
  useEffect(() => {
    versionRef.current = null
    let alive = true
    let busyPoll = false
    // 화면을 10분 넘게 안 만지면 묻기를 쉰다 (켜 둔 채 둔 탭이 저장소 호출을 계속 쓰지 않게). 만지면 바로 다시
    let lastActive = Date.now()
    const IDLE_MS = 10 * 60 * 1000
    const poll = async () => {
      if (busyPoll || document.visibilityState !== "visible" || Date.now() - lastActive > IDLE_MS) return
      busyPoll = true
      try {
        const known = versionRef.current
        const j = (await api(`/api/records?dataset=${dataset}${known != null ? `&since=${known}` : ""}`).then((res) => res.json())) as { version?: number; changed?: boolean }
        if (!alive || typeof j.version !== "number") return
        if (known != null && j.version !== known) refresh()
        versionRef.current = j.version
      } catch {
        // 잠깐 끊겨도 다음 차례에 다시 묻는다
      } finally {
        busyPoll = false
      }
    }
    const wake = () => {
      const idle = Date.now() - lastActive > IDLE_MS
      lastActive = Date.now()
      if (idle) poll()
    }
    poll()
    const timer = window.setInterval(poll, 3000)
    document.addEventListener("visibilitychange", poll)
    window.addEventListener("pointerdown", wake)
    window.addEventListener("keydown", wake)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
      window.removeEventListener("pointerdown", wake)
      window.removeEventListener("keydown", wake)
    }
  }, [dataset, change])
  // 서버에 기록 1건 (누가 하는지는 로그인 세션으로 서버가 정한다)
  const record = async (body: Record<string, unknown>) => {
    const res = await api("/api/records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataset, change, ...body }) })
    const j = (await res.json().catch(() => ({}))) as { version?: number; error?: string }
    if (!res.ok) throw new Error(j.error ?? `기록 실패 (${res.status})`)
    // 내가 쓴 만큼 버전을 올려 둔다 (다음 묻기에서 내 기록 때문에 또 받지 않게)
    if (typeof j.version === "number") versionRef.current = j.version
  }
  const confirmTask = async (t: Task, c: Confirm) => {
    const k = `${t.taskCode}|${t.hullId ?? ""}`
    sending.current.add(k)
    setLocal((l) => ({ ...l, [k]: c }))
    setSaveError(null)
    try {
      await record({ action: "confirm", task_code: t.taskCode, hull_id: t.hullId ?? null, answer: c.answer, edited_days: c.answer === "not_ok" ? c.days : null, reason: c.reason || null })
    } catch (e) {
      setLocal((l) => Object.fromEntries(Object.entries(l).filter(([x]) => x !== k)))
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      sending.current.delete(k)
      refresh()
    }
  }
  // 결정 · 결재는 서버가 다시 계산해서 기록한 뒤에 화면을 바꾼다
  const act = async (bodies: Record<string, unknown>[]) => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const b of bodies) await record(b)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      savingRef.current = true // 아래 refresh로 새 자료가 오면 풀린다
      refresh()
    }
  }
  // 바꾼 순서로 바로 열었으면(주소의 priority) 비교할 원래 추천도 받아 둔다
  useEffect(() => {
    if (!priority || baseRec) return
    const baseKey = `${dataset}/${change}`
    const cachedBase = reviewCache.get(baseKey)
    if (cachedBase) return setBaseRec(recLetter(cachedBase))
    api(`/api/review?dataset=${dataset}&change=${change}`)
      .then((res) => res.json())
      .then((j: { review?: Review }) => {
        if (!j.review) return
        const view = shiftView(j.review, offsetFrom(j.review.dataset.asOf))
        reviewCache.set(baseKey, view)
        setBaseRec(recLetter(view))
      })
      .catch(() => {})
  }, [dataset, change, priority, baseRec])
  // 주소에 단계 · 바꾼 우선순위를 남긴다 (링크 공유 · 발표)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    p.set("step", String(step))
    if (priority) p.set("priority", priority.join(","))
    else p.delete("priority")
    window.history.replaceState(window.history.state, "", `?${p}`) // 기록의 스크롤 위치(state)는 그대로 둔다
  }, [step, priority])
  // 단계를 옮기면 맨 위에서 시작 (처음 열 때는 App이 맞춘다)
  const stepShown = useRef(false)
  useEffect(() => {
    if (!stepShown.current) {
      stepShown.current = true
      return
    }
    window.scrollTo(0, 0)
  }, [step])
  // ← → 로 단계 넘기기 (입력 중에는 안 함)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "ArrowRight") setStep((s) => Math.min(7, s + 1))
      if (e.key === "ArrowLeft") setStep((s) => Math.max(1, s - 1))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const derived = useMemo(() => {
    if (!r) return null
    // 결정 상태는 서버 기록 그대로 (재검토 · 반려로 돌아가면 r.decision이 없다)
    const decided: Decided | null = r.decision ? { option: r.decision.optionKey, state: r.decision.state.code === "approval_pending" ? "pending" : "done" } : null
    const rec = r.options.find((o) => o.key === r.recommended?.key) ?? null
    const chosen = decided ? (r.options.find((o) => o.key === decided.option) ?? rec) : rec
    const tasks = chosen?.tasks ?? r.tasks
    return { decided, rec, chosen, tasks, rows: hullRows(r, chosen) }
  }, [r])

  if (error) return <div className="card mt-empty">{error}</div>
  if (!r || !derived)
    return (
      <div className="mt">
        <div className="page-title">
          <div>
            {back && (
              <button className="back-link" onClick={back}>
                ← 설계변경 목록
              </button>
            )}
            <h1>{change}</h1>
            <p className="mt-skel-line" />
          </div>
        </div>
        <div className="mt-steps mt-skel">{STEPS.map((s) => <div key={s.no} className="mt-skel-step"><i /><i /></div>)}</div>
        <div className="card mt-panel mt-skel"><div className="mt-skel-block" /></div>
      </div>
    )
  const { decided, rec, chosen, tasks, rows } = derived
  const teams = teamsOf(tasks, local)
  const okN = teams.filter((t) => t.status === "ok").length
  const notOkN = teams.filter((t) => t.status === "not_ok").length
  const d = r.recommended?.deadline ?? null
  const isChair = !!user && user.employeeId === r.summary.chair.employeeId
  // 결재자: 결정 뒤에는 서버가 만든 결재 건의 결재자, 그 전에는 시리즈 계약관리 담당
  const approvals = r.decision?.approvals ?? []
  const approver = approvals[0] ? { employeeId: approvals[0].approverId, name: approvals[0].approver } : (tasks.find((t) => t.role === "pm" && !t.hullId)?.owner ?? r.tasks.find((t) => t.role === "pm")?.owner ?? null)
  const isApprover = !!user && !!approver?.employeeId && user.employeeId === approver.employeeId
  const myApprovals = user ? approvals.filter((a) => a.state === "pending" && a.approverId === user.employeeId) : []
  const needsApproval = !!chosen?.approval.needed

  // 단계 막대의 요약 토큰
  const tokens: Record<number, React.ReactNode> = {
    1: <span className="mt-token-text">{r.summary.specBefore && r.summary.specAfter ? `${r.summary.specBefore.replace(/^.*?(\d+\s*t).*$/, "$1")} → ${r.summary.specAfter.replace(/^.*?(\d+\s*t).*$/, "$1")}` : partsSummary(r.common.parts)}</span>,
    2: <HullStrip hulls={r.strip} tone={stateTone} size="xs" />,
    3: r.designOnly ? <span className="mt-token-text">도면 변경</span> : <HullStrip hulls={r.strip} tone={(h) => rows.find((x) => x.h.hullId === h.hullId)?.tone ?? "neutral"} size="xs" />,
    4: r.designOnly ? <span className="mt-token-text">대응안 없음</span> : <span className="mt-token-row"><span className="mt-letter sm">{rec?.letter || "–"}</span><span className="mt-token-text">추천</span></span>,
    5: (
      <span className="mt-token-row">
        <span className="mt-token-num">{okN}/{teams.length}</span>
        {notOkN > 0 && <span className="mt-dot danger" />}
        <span className="mt-token-text">가능</span>
      </span>
    ),
    6: decided ? (
      <span className="mt-token-text">{decided.state === "pending" ? "결재 대기" : "결정 완료"}</span>
    ) : (
      <span className="mt-token-row">
        {d && !r.designOnly && <span className={`mt-pill ${d.badge ? "danger" : "neutral"}`}>{ddayText(d.dday)}</span>}
        <span className="mt-token-text">미결정</span>
      </span>
    ),
    7: <span className="mt-token-text">{decided ? `업무 ${tasks.length}건` : "결정 후 개시"}</span>,
  }
  const attention: Record<number, boolean> = { 5: notOkN > 0, 6: decided?.state === "pending" || (!decided && !!d?.badge && !r.designOnly) }

  return (
    <div className="mt">
      <div className="page-title">
        <div>
          {back && (
            <button className="back-link" onClick={back}>
              ← 설계변경 목록
            </button>
          )}
          <h1>
            <span className="numeric">{r.summary.id}</span> {r.summary.title}
          </h1>
          <p>
            {r.summary.reason.label} · {r.summary.requester} · 주관 {r.summary.chair.name} ({r.summary.chair.department})
          </p>
        </div>
        {r.summary.mandatory && <span className="status-pill danger">필수 변경</span>}
      </div>

      <nav className="mt-steps" aria-label="회의 순서">
        {STEPS.map((s) => (
          <button key={s.no} className={`mt-step ${step === s.no ? "on" : ""} ${s.no < step ? "past" : ""} ${attention[s.no] ? "attn" : ""}`} onClick={() => setStep(s.no)} aria-current={step === s.no ? "step" : undefined}>
            <span className="mt-step-top">
              <span className="mt-step-no">{s.no}</span>
              <span className="mt-step-name">{s.name}</span>
            </span>
            <span className="mt-step-token">{tokens[s.no]}</span>
          </button>
        ))}
      </nav>

      <section className="card mt-panel">
        <div className="mt-panel-head">
          <span className="mt-panel-no">{step}</span>
          <h2>{STEPS[step - 1].title}</h2>
        </div>
        {step === 1 && <Step1 r={r} />}
        {step === 2 && <Step2 r={r} />}
        {step === 3 && <Step3 r={r} rows={rows} />}
        {step === 4 && <Step4 r={r} priority={priority} setPriority={setPriority} baseRec={baseRec} busy={busy} locked={!!decided || !!r.decision} />}
        {saveError && <p className="mt-small danger-text">기록 실패 · {saveError}</p>}
        {step === 5 && <Step5 r={r} chosen={chosen} tasks={tasks} local={local} onAnswer={confirmTask} />}
        {step === 6 && (
          <Step6
            r={r}
            chosen={chosen}
            tasks={tasks}
            local={local}
            decided={decided}
            isChair={isChair}
            isApprover={isApprover}
            approverName={approver?.name ?? "계약관리"}
            needsApproval={needsApproval}
            saving={saving}
            onDecide={() => act([{ action: "decide", option: chosen!.key, ...(priority ? { priority } : {}) }])}
            onApprove={() => act(myApprovals.map((a) => ({ action: "approve", approval_id: a.id, answer: "approved" })))}
            onReject={(comment) => myApprovals[0] && act([{ action: "approve", approval_id: myApprovals[0].id, answer: "rejected", comment }])}
          />
        )}
        {step === 7 && <Step7 r={r} tasks={tasks} decided={!!decided} />}
        <div className="mt-panel-foot">
          <button className="secondary-button" disabled={step === 1} onClick={() => setStep(step - 1)}>
            ← {step > 1 ? STEPS[step - 2].name : "이전"}
          </button>
          <button className="primary-button" disabled={step === 7} onClick={() => setStep(step + 1)}>
            {step < 7 ? STEPS[step].name : "종료"} →
          </button>
        </div>
      </section>
    </div>
  )
}

// ① 변경 개요: 한 장의 표 (옅은 회색 덧말 · 출처 표시 없음. 호선별 내용은 ②③에서)
function Step1({ r }: { r: Review }) {
  const [open, setOpen] = useState(false)
  // 표 안의 옅은 회색 덧말은 쓰지 않는다 (행 이름 · 앞 값과 같은 말 반복이라)
  const classApproval = r.common.classApproval.replace(/\s*\(시리즈 공통 1회\)/, "")
  return (
    <div className="mt-body">
      <table className="mt-table">
        <tbody>
          <tr>
            <th>요청 주체</th>
            <td><b>{r.summary.requester}</b></td>
          </tr>
          <tr>
            <th>변경 대상</th>
            <td>{partsSummary(r.common.parts)}</td>
          </tr>
          <tr className="emph">
            <th>변경 내용</th>
            <td>
              <span className="mt-spec before">{r.summary.specBefore ?? "-"}</span>
              <span className="mt-spec-arrow" aria-hidden="true">→</span>
              <span className="mt-spec after">{r.summary.specAfter ?? "-"}</span>
            </td>
          </tr>
          <tr>
            <th>변경 원인</th>
            <td><b>{r.summary.reason.label}</b></td>
          </tr>
          <tr>
            <th>시리즈 공통</th>
            <td>{r.designOnly ? "도면 변경 (형상 변화 없음)" : `변경 자재 ${r.common.materials.length}종 · 견적 ${r.common.quotes.length}건 · ${classApproval}`}</td>
          </tr>
          <tr>
            <th>접수</th>
            <td>{r.summary.source} · <span className="numeric">{md(r.summary.receivedAt)}</span></td>
          </tr>
        </tbody>
      </table>
      <button className="mt-fold" onClick={() => setOpen(!open)}>{open ? "접기 ▴" : "요청 원문 · 변경 자재 ▾"}</button>
      {open && (
        <div className="mt-fold-body">
          <p className="mt-quote">“{r.summary.originalText}”</p>
          <ul className="mt-chips">{r.common.materials.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
    </div>
  )
}

// ② 진행 현황: 호선마다 '이번 변경에 걸린 부품'이 어느 단계인지 (부품 단위)
//   위: 호선 단계 띠(운항 · 건조 · 설계 · 계획) · 가운데: 부품 상태 막대(개수 표시) · 아래: 호선 상태 이름표
const partState = (h: Hull) => {
  const { installed: ins, fabricated: fab, notStarted: nst } = h.units
  if (!ins && !fab && !nst) return { label: "해당 없음", tone: "none" }
  if (ins && !fab && !nst) return { label: "설치 완료", tone: "ins" }
  if (ins) return { label: "설치 일부", tone: "ins-part" }
  if (fab && !nst) return { label: "제작 완료", tone: "fab" }
  if (fab) return { label: "제작 일부", tone: "fab-part" }
  return { label: "미착수", tone: "nst" }
}
function Step2({ r }: { r: Review }) {
  const max = Math.max(1, ...r.strip.map(total))
  const service = r.strip.filter((h) => h.lifecycle.code === "in_service" && total(h)).length
  const touched = r.strip.filter((h) => h.lifecycle.code !== "in_service" && (h.units.installed || h.units.fabricated)).length
  const fresh = r.strip.filter((h) => h.lifecycle.code !== "in_service" && !h.units.installed && !h.units.fabricated && h.units.notStarted).length
  // 같은 단계(운항 · 건조 · 설계 · 계획)인 이웃 호선을 한 구간으로
  const phases: { code: string; label: string; n: number }[] = []
  for (const h of r.strip) {
    const last = phases.at(-1)
    if (last && last.code === h.lifecycle.code) last.n++
    else phases.push({ code: h.lifecycle.code, label: lifeShort(h), n: 1 })
  }
  const seg = (n: number, cls: string) =>
    n ? (
      <i className={cls} style={{ height: `${(n / max) * 100}%` }}>
        {n / max >= 0.14 && <span>{n}</span>}
      </i>
    ) : null
  return (
    <div className="mt-body">
      <div className="mt-big-stats">
        <div><span>운항 중</span><b>{service}</b><em>척</em></div>
        <div><span>제작 · 설치 진행</span><b>{touched}</b><em>척</em></div>
        <div><span>미착수</span><b>{fresh}</b><em>척</em></div>
      </div>
      <div className="mt-s2">
        <div className="mt-phases" style={{ gridTemplateColumns: `repeat(${r.strip.length}, 1fr)` }}>
          {phases.map((p, i) => (
            <span key={i} className={`mt-phase ${p.code}`} style={{ gridColumn: `span ${p.n}` }}>
              {p.label} <b>{p.n}척</b>
            </span>
          ))}
        </div>
        <div className="mt-bars" style={{ gridTemplateColumns: `repeat(${r.strip.length}, 1fr)` }}>
          {r.strip.map((h) => {
            const st = partState(h)
            // 이미 만든 · 설치한 부품이 있거나 운항 중이면 기존 부품 조치가 생기는 호선 → 옅은 빨강
            const issue = h.lifecycle.code === "in_service" ? total(h) > 0 : h.units.installed + h.units.fabricated > 0
            return (
              <div key={h.hullId} className={`mt-bar-col ${issue ? "issue" : ""}`}>
                <div className="mt-bar">
                  {total(h) ? (
                    <>
                      {seg(h.units.notStarted, "nst")}
                      {seg(h.units.fabricated, "fab")}
                      {seg(h.units.installed, "ins")}
                    </>
                  ) : (
                    <em>해당 없음</em>
                  )}
                </div>
                <strong className="numeric">{h.seq}호선</strong>
                <span className={`mt-state ${st.tone}`}>{st.label}</span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="mt-legend">
        <span><i className="ins" /> 설치 완료</span>
        <span><i className="fab" /> 제작 완료</span>
        <span><i className="nst" /> 미착수</span>
        <span><i className="issue" /> 기존 부품 조치 필요 호선</span>
      </div>
    </div>
  )
}

// ③ 영향 분석: 상태별 조치 사항 + 결정 기한
function Step3({ r, rows }: { r: Review; rows: ReturnType<typeof hullRows> }) {
  if (r.designOnly)
    return (
      <div className="mt-body">
        <div className="mt-calm">생산 부품 영향 없음 · 도면 변경에 따른 부서별 조치 사항만 확인</div>
      </div>
    )
  return (
    <div className="mt-body">
      <table className="mt-impact">
        <thead>
          <tr>
            <th>호선</th>
            <th>변경 대상 부품</th>
            <th>조치</th>
            <th>작업</th>
            <th>기한</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ h, tone, excluded, parts, act, work, due }) => (
            <tr key={h.hullId} className={`tone-row-${tone}`}>
              <td>
                <span className={`mt-impact-hull tone-${tone}`}>{h.seq}호선</span>
              </td>
              <td className="numeric">{parts || <span className="mt-faint">-</span>}</td>
              <td>{act ?? <span className="mt-faint">-</span>}</td>
              <td>
                {work.length ? (
                  <ul className="mt-check">
                    {work.map((w) => (
                      <li key={w.label}>
                        <i aria-hidden="true" />
                        {w.label} <small>{w.role}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="mt-faint">{excluded || !parts ? "-" : "호선별 추가 작업 없음"}</span>
                )}
              </td>
              <td className="numeric">
                {due ? (
                  <span className={due.passed ? "mt-due passed" : "mt-due"}>
                    {due.what} {md(due.date)}
                    {due.passed && <small>경과</small>}
                  </span>
                ) : (
                  <span className="mt-faint">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ④ 대응안: 안마다 카드 + 해당 안 적용 시 호선별 결과 (같은 자리 호선 띠)
function Step4({ r, priority, setPriority, baseRec, busy, locked }: { r: Review; priority: string[] | null; setPriority: (p: string[] | null) => void; baseRec: string | null; busy: boolean; locked: boolean }) {
  if (r.designOnly) return <div className="mt-body"><div className="mt-calm">대응안 해당 없음 (도면 변경)</div></div>
  const order = r.priority.order
  const recNow = r.options.find((o) => o.recommended)?.letter ?? null
  const changed = !!priority && !!baseRec && !!recNow && baseRec !== recNow
  const best = (pick: (o: Opt) => number) => Math.min(...r.options.map(pick))
  const allSame = (pick: (o: Opt) => number) => r.options.every((o) => pick(o) === pick(r.options[0]))
  // 강조는 조선소 실부담 · 재작업만 (총비용은 선주 청구분이 섞여 있어 굵게 하지 않는다)
  const isBest = (pick: (o: Opt) => number, o: Opt) => !allSame(pick) && pick(o) === best(pick)
  // 대응안이 무엇을 고르는 것인지: 모든 안이 같은 호선 처리(공통) vs 안마다 다른 호선 처리(차이)
  const treatOf = (o: Opt, id: string) => o.hulls.find((x) => x.hullId === id)?.treatment ?? "not_applicable"
  const touched = r.strip.filter((h) => total(h) > 0)
  const common = touched.filter((h) => r.options.every((o) => treatOf(o, h.hullId) === treatOf(r.options[0], h.hullId)))
  const differ = touched.filter((h) => !common.includes(h))
  const commonText = r.options.length ? byTreatment(common, (h) => (TREAT[treatOf(r.options[0], h.hullId)] ?? []).join(" · "), " · ") : ""
  const payer = (o: Opt) => (o.cost.total > 0 && o.cost.ownerShare >= o.cost.total ? "전액 선주 청구" : o.cost.ownerShare > 0 ? `선주 청구 ${won(o.cost.ownerShare)}` : null)
  return (
    <div className={`mt-body ${busy ? "mt-busy" : ""}`}>
      {r.options.length > 1 && (
        <div className="mt-criteria">
          <span className="mt-criteria-label">추천 기준</span>
          <span className="mt-crit gate">계약 납기 준수</span>
          <span className="mt-crit-sep" aria-hidden="true">›</span>
          {order.map((c, i) => (
            <button key={c} className={`mt-crit ${i === 0 ? "first" : ""}`} disabled={locked || i === 0} onClick={() => setPriority([c, ...order.filter((x) => x !== c)])}>
              <i className="numeric">{i + 1}</i>
              {CRITERION[c] ?? c}
            </button>
          ))}
          <span className="mt-crit-source">{locked ? "결정 시 기준" : priority ? "회의 중 변경" : r.priority.source === "선주 회신" ? "선주 회신 기준" : "기본 순서"}</span>
          {priority && !locked && (
            <button className="mt-crit-reset" onClick={() => setPriority(null)}>
              원래 순서
            </button>
          )}
        </div>
      )}
      {r.options.length > 1 && (
        <dl className="mt-opt-frame">
          {commonText && (
            <div>
              <dt>모든 대응안 공통</dt>
              <dd>{commonText}</dd>
            </div>
          )}
          <div>
            <dt>대응안별 차이</dt>
            <dd>{[differ.length ? `${hullRange(differ)} 기존 부품 처리` : null, "자재 조달 방법 · 입고일", "비용"].filter(Boolean).join(" · ")}</dd>
          </div>
        </dl>
      )}
      <div className="mt-options" style={{ gridTemplateColumns: `repeat(${r.options.length + r.unavailable.length}, 1fr)` }}>
        {r.options.map((o) => (
          <div key={o.key} className={`mt-option ${o.recommended ? "rec" : ""}`}>
            {o.recommended && <span className="mt-rec-flag">추천</span>}
            <div className="mt-option-head">
              <span className="mt-letter">{o.letter || "범위"}</span>
              <b>{o.label.replace(/^[ABC]\s/, "")}</b>
            </div>
            <dl className="mt-option-plan">
              {(() => {
                const existing = r.strip.filter((h) => h.lifecycle.code !== "in_service" && h.units.installed + h.units.fabricated > 0 && treatOf(o, h.hullId) !== "not_applicable")
                return existing.length > 0 ? (
                  <div>
                    <dt>기존 부품</dt>
                    <dd>{byTreatment(existing, (h) => PART_ACT[treatOf(o, h.hullId)] ?? treatOf(o, h.hullId), ", ")}</dd>
                  </div>
                ) : null
              })()}
              {o.tasks.some((t) => t.taskCode.startsWith("order_")) && (
                <div>
                  <dt>자재</dt>
                  <dd>
                    {o.tasks
                      .filter((t) => t.taskCode.startsWith("order_"))
                      .sort((a, b) => a.finish.localeCompare(b.finish))
                      .map((t) => (
                        <span key={t.taskCode}>
                          {t.label.replace(/ · 입고$/, "")} <small className="numeric">{Math.round(t.days)}일 · {md(t.finish)} 입고</small>
                        </span>
                      ))}
                  </dd>
                </div>
              )}
            </dl>
            <div className={`mt-verdict ${o.metrics.overrunSum ? "danger" : "success"}`}>
              {o.metrics.overrunSum ? `계약 납기 ${o.metrics.overrunMax}일 초과` : "계약 납기 준수"}
            </div>
            <HullStrip hulls={r.strip} tone={(h) => outcomeTone(o.hulls.find((x) => x.hullId === h.hullId))} />
            <dl className="mt-option-metrics">
              <div className={`yard ${isBest((x) => x.cost.yardShare, o) ? "best" : ""}`}>
                <dt>조선소 실부담</dt>
                <dd>{won(o.cost.yardShare)}</dd>
              </div>
              <div>
                <dt>총비용</dt>
                <dd>
                  {won(o.cost.total)}
                  {payer(o) && <small>{payer(o)}</small>}
                </dd>
              </div>
              <div className={isBest((x) => x.metrics.reworkHours, o) ? "best" : ""}>
                <dt>재작업</dt>
                <dd>{Math.round(o.metrics.reworkHours)}시간</dd>
              </div>
            </dl>
            {o.approval.needed && <span className="mt-approval">결재 필요 · {o.approval.triggers.map((t) => (t.code === "contract_overrun" ? "납기 초과" : t.code === "yard_cost" ? "실부담 초과" : "선주 동의")).join(" · ")}</span>}
          </div>
        ))}
        {r.unavailable.map((u) => (
          <div key={u.key} className="mt-option off">
            <div className="mt-option-head">
              <span className="mt-letter">{u.label.slice(0, 1)}</span>
              <b>{LETTER_NAME[u.key] ?? u.label}</b>
            </div>
            <p>해당 없음</p>
            <small>{u.why}</small>
          </div>
        ))}
      </div>
      <div className="mt-legend">
        <span><i className="tone-success" /> 납기 준수</span>
        <span><i className="tone-warning" /> 여유 3일 이하</span>
        <span><i className="tone-danger" /> 계약 납기 초과</span>
        <span><i className="tone-primary" /> 인도 후 개조</span>
        <span><i className="tone-neutral" /> 해당 없음</span>
      </div>
      {r.recommended && (
        <div className="mt-why">
          <b>
            추천 사유 ({recNow})
            {changed && <span className="mt-rec-change">우선순위 변경으로 추천 {baseRec} → {recNow}</span>}
          </b>
          <ol>{r.recommended.reasons.map((x) => <li key={x}>{x}</li>)}</ol>
        </div>
      )}
    </div>
  )
}

// ⑤ 부서 검토: 해당 안의 납기 · 비용 · 생산 + 부서 타일 (가능 초록 · 불가 빨강 · 미확인 회색) + 본인 담당 업무
function Step5({ r, chosen, tasks, local, onAnswer }: { r: Review; chosen: Opt | null; tasks: Task[]; local: Record<string, Confirm>; onAnswer: (t: Task, c: Confirm) => void }) {
  const { user } = useAuth()
  const teams = teamsOf(tasks, local)
  const [openTeam, setOpenTeam] = useState<string | null>(() => teams.find((t) => t.status === "not_ok")?.team ?? null)
  const live = (chosen?.hulls ?? []).filter((h) => !["post_delivery", "not_applicable"].includes(h.treatment))
  const tight = live.slice().sort((a, b) => between(a.newDelivery, a.contractDate) - between(b.newDelivery, b.contractDate))[0]
  const mine = user ? tasks.filter((t) => t.owner.employeeId === user.employeeId) : []
  const count = (s: "ok" | "not_ok" | "wait") => teams.filter((t) => t.status === s).length
  const team = teams.find((t) => t.team === openTeam)
  return (
    <div className="mt-body">
      {chosen && !r.designOnly && (
        <div className="mt-kpis">
          <div className={`mt-kpi ${chosen.metrics.overrunSum ? "danger" : tight && between(tight.newDelivery, tight.contractDate) <= 3 ? "warning" : "success"}`}>
            <span>납기</span>
            <b>{chosen.metrics.overrunSum ? `${chosen.metrics.overrunMax}일 초과` : tight ? `여유 ${between(tight.newDelivery, tight.contractDate)}일` : "준수"}</b>
            <small>{tight ? `최소 여유 ${tight.seq}호선` : ""}</small>
          </div>
          <div className="mt-kpi">
            <span>비용</span>
            <b>실부담 {wonShort(chosen.cost.yardShare)}</b>
            <small>총비용 {won(chosen.cost.total)}</small>
          </div>
          <div className="mt-kpi">
            <span>생산</span>
            <b>재작업 {Math.round(chosen.metrics.reworkHours)}시간</b>
            <small>공정 지연 합계 {chosen.metrics.localDelaySum}일</small>
          </div>
        </div>
      )}
      {mine.length > 0 && <MyTasks tasks={mine} local={local} onAnswer={onAnswer} name={user!.name} />}
      <div className="mt-team-summary">
        <b className="ok-text">가능 {count("ok")}</b>
        <span> · </span>
        <b className="danger-text">불가 {count("not_ok")}</b>
        <span> · 미확인 {count("wait")}</span>
      </div>
      <div className="mt-teams">
        {teams.map((t) => (
          <button key={t.team} className={`mt-team ${t.status} ${openTeam === t.team ? "open" : ""} ${user && t.ownerIds.has(user.employeeId) ? "mine" : ""}`} onClick={() => setOpenTeam(openTeam === t.team ? null : t.team)}>
            <span className="mt-team-top">
              <b>{t.team}</b>
              <span className={`mt-team-state ${t.status}`}>{STATE_LABEL[t.status]}</span>
            </span>
            <span className="mt-team-owner">{t.owners.join(" · ")}</span>
            <span className="mt-team-meta numeric">
              업무 {t.tasks.length} · ~{md(t.last)}
              {t.short > 0 && <i className="danger">여유 부족 {t.short}</i>}
              {t.tight > 0 && <i className="warning">촉박 {t.tight}</i>}
            </span>
          </button>
        ))}
      </div>
      {team && (
        <div className="mt-team-detail">
          {team.tasks.map((x) => {
            const c = local[`${x.taskCode}|${x.hullId ?? ""}`] ?? (x.confirmation ? { answer: x.confirmation.answer as "ok" | "not_ok", days: x.confirmation.edited_days, reason: x.confirmation.reason ?? "" } : null)
            return (
              <div key={x.taskCode + x.hullId} className="mt-task-row">
                <span className={`mt-dot ${c?.answer === "ok" ? "success" : c?.answer === "not_ok" ? "danger" : "neutral"}`} />
                <span className="mt-task-label">{x.label}</span>
                <span className="mt-task-owner">{x.owner.name}{x.counterpart ? ` ↔ ${x.counterpart}` : ""}</span>
                <span className="mt-task-date numeric">{md(x.start)}–{md(x.finish)}{x.slack != null ? ` · 여유 ${x.slack}일` : ""}</span>
                {c?.answer === "not_ok" && <span className="mt-task-note">{c.days != null ? `기간 ${c.days}일로 조정` : "일정 불가"}{c.reason ? ` — “${c.reason}”` : ""}</span>}
              </div>
            )
          })}
        </div>
      )}
      {r.suggestions.length > 0 && <p className="mt-small">유사 사례 참여 부서 중 금번 미포함: {r.suggestions.map((s) => `${s.party} (${s.share})`).join(" · ")}</p>}
    </div>
  )
}

function MyTasks({ tasks, local, onAnswer, name }: { tasks: Task[]; local: Record<string, Confirm>; onAnswer: (t: Task, c: Confirm) => void; name: string }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [days, setDays] = useState(0)
  const [reason, setReason] = useState("")
  return (
    <div className="mt-mine">
      <b>담당 업무 · {name} ({tasks.length}건)</b>
      {tasks.map((t) => {
        const k = `${t.taskCode}|${t.hullId ?? ""}`
        const answer = local[k]?.answer ?? (t.confirmation?.answer as "ok" | "not_ok" | undefined)
        return (
          <div key={k} className="mt-mine-row">
            <span>{t.label} <small className="numeric">{md(t.start)}–{md(t.finish)} · {t.days}일</small></span>
            {editing === k ? (
              <span className="mt-mine-form">
                <input type="number" min={0} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="조정 기간" />일
                <input placeholder="사유" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="primary-button" disabled={!reason.trim()} onClick={() => { onAnswer(t, { answer: "not_ok", days, reason: reason.trim() }); setEditing(null) }}>제출</button>
                <button className="ghost-button" onClick={() => setEditing(null)}>취소</button>
              </span>
            ) : (
              <span className="mt-mine-buttons">
                <button className={answer === "ok" ? "primary-button" : "secondary-button"} onClick={() => onAnswer(t, { answer: "ok", days: null, reason: "" })}>가능</button>
                <button className={answer === "not_ok" ? "primary-button danger" : "secondary-button"} onClick={() => { setDays(t.days + 3); setReason(""); setEditing(k) }}>불가</button>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ⑥ 의사결정: 결정서 + 단계 (결정 → 결재 → 결재 완료)
type Step6Props = {
  r: Review
  chosen: Opt | null
  tasks: Task[]
  local: Record<string, Confirm>
  decided: Decided | null
  isChair: boolean
  isApprover: boolean
  approverName: string
  needsApproval: boolean
  saving: boolean
  onDecide: () => void
  onApprove: () => void
  onReject: (comment: string) => void
}
function Step6({ r, chosen, tasks, local, decided, isChair, isApprover, approverName, needsApproval, saving, onDecide, onApprove, onReject }: Step6Props) {
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState("")
  if (r.designOnly) return <div className="mt-body"><div className="mt-calm">대응안 해당 없음 · 부서별 조치 사항만 확인</div></div>
  const teams = teamsOf(tasks, local)
  const stage = !decided ? 0 : decided.state === "pending" ? 1 : 2
  const others = r.options.filter((o) => o.key !== chosen?.key)
  const owner = tasks.filter((t) => t.counterpartKind === "owner")
  const count = (s: "ok" | "not_ok" | "wait") => teams.filter((t) => t.status === s)
  // 결정 기한: 이 날을 넘기면 추천안의 일정이 나빠지기 시작하는 날 (엔진 계산). 결정 전에만 표시
  const due = !decided && !r.decision ? (r.recommended?.deadline ?? null) : null
  const loss = missed(due?.ifMissed)
  return (
    <div className="mt-body">
      <ol className="mt-pipe">
        <li className={stage === 0 ? "on" : "done"}><b>결정</b><small>{r.decision ? `${r.decision.decidedBy} · ${md(r.decision.day)}` : `주관 ${r.summary.chair.name}`}</small></li>
        {needsApproval && <li className={stage === 1 ? "on" : stage > 1 ? "done" : ""}><b>결재</b><small>계약관리 {approverName}</small></li>}
        <li className={stage === 2 ? "done on" : ""}><b>{needsApproval ? "결재 완료" : "확정"}</b><small>후속 조치 개시</small></li>
      </ol>
      <div className="mt-doc">
        <div className="mt-doc-main">
          <span className="mt-doc-kicker">{decided ? "결정서" : "결정서 (초안)"}</span>
          <div className="mt-doc-pick">
            <span className="mt-letter">{chosen?.letter}</span>
            <div>
              <b>{chosen?.label}</b>
              <small>{r.decision?.rationale ?? r.recommended?.reasons[0]}</small>
            </div>
          </div>
          <dl className="mt-doc-list">
            {due && (
              <div className={due.badge ? "urgent" : ""}>
                <dt>결정 기한</dt>
                <dd>
                  <b className="numeric">{md(due.date)} ({ddayText(due.dday)})</b>
                  {due.threshold && ` · 초과 시 ${due.threshold.seq}호선부터 일정 영향`}
                </dd>
              </div>
            )}
            {due && loss.length > 0 && (
              <div>
                <dt>{due.ifMissed.days}일 초과 시</dt>
                <dd>{loss.map((x) => `${x.label} ${x.value}`).join(" · ")}</dd>
              </div>
            )}
            <div><dt>검토 대안</dt><dd>{others.map((o) => `${o.label}: ${o.metrics.overrunSum ? `계약 납기 ${o.metrics.overrunMax}일 초과` : "계약 납기 준수"}`).join(" · ") || "없음"}</dd></div>
            <div><dt>비용</dt><dd>총비용 {won(chosen?.cost.total ?? 0)} · 조선소 실부담 {won(chosen?.cost.yardShare ?? 0)}</dd></div>
            <div><dt>부서 검토</dt><dd>가능 {count("ok").length} · 불가 {count("not_ok").map((t) => t.team).join(" · ") || "없음"} · 미확인 {count("wait").length}</dd></div>
            {owner.length > 0 && <div><dt>선주 협의</dt><dd>{owner.map((t) => `${t.label} (${t.owner.name}, ~${md(t.finish)})`).join(" · ")}</dd></div>}
            <div><dt>부서별 업무</dt><dd>{teams.map((t) => `${t.team} ${t.tasks.length}`).join(" · ")}</dd></div>
          </dl>
        </div>
        <div className="mt-doc-side">
          {stage === 0 && (
            <>
              <button className="primary-button mt-big-button" disabled={!isChair || saving} onClick={onDecide}>
                {saving ? "기록 중" : needsApproval ? "결정 및 결재 상신" : "결정"}
              </button>
              {!isChair && <small>결정 권한: 주관 {r.summary.chair.name}</small>}
            </>
          )}
          {stage === 1 && (
            <>
              <span className="status-pill warning">결재 대기</span>
              <small>결재자 {approverName} · 사유: {chosen?.approval.triggers.map((t) => t.label).join(" · ")}</small>
              {isApprover && rejecting ? (
                <span className="mt-approve-buttons">
                  <input placeholder="반려 사유" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="반려 사유" />
                  <button className="ghost-button" onClick={() => setRejecting(false)}>취소</button>
                  <button className="primary-button danger" disabled={!comment.trim() || saving} onClick={() => { onReject(comment.trim()); setRejecting(false); setComment("") }}>반려</button>
                </span>
              ) : isApprover ? (
                <span className="mt-approve-buttons">
                  <button className="secondary-button" disabled={saving} onClick={() => setRejecting(true)}>반려</button>
                  <button className="primary-button" disabled={saving} onClick={onApprove}>{saving ? "기록 중" : "승인"}</button>
                </span>
              ) : (
                <small>결재 권한: {approverName}</small>
              )}
            </>
          )}
          {stage === 2 && (
            <>
              <span className="status-pill success">{needsApproval ? "결재 완료" : "결정 완료"}</span>
              <small>{r.decision ? `${md(r.decision.day)} 결정 (${r.decision.decidedBy})` : "후속 조치로 이관 (7단계)"}</small>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ⑦ 후속 조치: 업무 일정표 (기준일 선). 결정 전에는 흐리게 표시
function Step7({ r, tasks, decided }: { r: Review; tasks: Task[]; decided: boolean }) {
  const today = r.dataset.asOf.slice(0, 10)
  const start = [today, ...tasks.map((t) => t.start)].sort()[0]
  const end = tasks.map((t) => t.finish).sort().at(-1) ?? today
  const span = Math.max(1, between(start, end))
  const pos = (d: string) => `${(between(start, d) / span) * 100}%`
  const groups = new Map<string, Task[]>()
  for (const t of tasks) groups.set(t.roleLabel, [...(groups.get(t.roleLabel) ?? []), t])
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const day = dayNum(start) + Math.round((span * i) / 4)
    const dt = new Date(day * 86400000)
    return { left: `${(i / 4) * 100}%`, label: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}` }
  })
  return (
    <div className={`mt-body ${decided ? "" : "mt-dim"}`}>
      {!decided && <div className="mt-calm">결정 시 아래 일정으로 업무 개시 · 시스템 실적(ERP 입고 · PLM 도면 승인 · MES 실적) 발생 시 자동 완료</div>}
      <div className="mt-gantt">
        <div className="mt-gantt-axis">
          <span />
          <div className="mt-gantt-ticks">{ticks.map((t) => <span key={t.left} style={{ left: t.left }}>{t.label}</span>)}</div>
        </div>
        {[...groups].map(([team, list]) => (
          <div key={team} className="mt-gantt-group">
            {list.map((t, i) => (
              <div key={t.taskCode + t.hullId} className="mt-gantt-row">
                <span className="mt-gantt-label">{i === 0 ? <b>{team}</b> : null}<em>{t.label}</em></span>
                <div className="mt-gantt-track">
                  <i className="mt-gantt-today" style={{ left: pos(today) }} />
                  <span className={`mt-gantt-bar ${t.flag ?? ""}`} style={{ left: pos(t.start), width: `max(4px, calc(${pos(t.finish)} - ${pos(t.start)}))` }} title={`${t.label} ${md(t.start)}–${md(t.finish)} · ${t.owner.name}`} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-legend">
        <span><i className="gbar" /> 업무</span>
        <span><i className="gbar tight" /> 촉박</span>
        <span><i className="gbar short" /> 여유 부족</span>
        <span><i className="gtoday" /> 기준일 ({md(today)})</span>
      </div>
    </div>
  )
}
