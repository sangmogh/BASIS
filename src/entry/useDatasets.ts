// 첫 화면 프로젝트 목록 · 사이드바 '결정 대기' 숫자: 새 엔진(/api/datasets)에서 (설계변경 목록 · 회의 화면과 같은 값)
//   예전에는 첫 화면은 옛 엔진(src/engine) + 손으로 적은 portfolio.json, 사이드바는 옛 저장소 숫자를 써서 다른 화면과 어긋났다
import { useEffect, useState } from "react"
import { api } from "../auth/session"
import { offsetFrom, shiftView } from "../meeting/clock"

export type DatasetSummary = {
  hullRange: string
  stage: string
  inProduction: number
  progress: number
  open: number
  nearestDeadline: { date: string; dday: number } | null
}
export type DatasetRow = { id: string; name: string; series: string; shipType: string; hulls: number; asOf: string; summary: DatasetSummary; error?: string | null }

let all: DatasetRow[] | null = null

// 모든 데이터셋 (날짜는 각 데이터셋 기준일 → 오늘로 옮겨서)
export function useDatasets() {
  const [rows, setRows] = useState<DatasetRow[] | null>(all)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api("/api/datasets")
      .then((r) => r.json())
      .then((j: { datasets?: DatasetRow[]; error?: string }) => {
        if (!j.datasets) return setError(j.error ?? "프로젝트를 불러오지 못했어요")
        all = j.datasets.filter((d) => !d.error && d.summary).map((d) => shiftView(d, offsetFrom(d.asOf)))
        setRows(all)
      })
      .catch((e) => setError(String(e)))
  }, [])
  return { rows, error }
}

// 한 데이터셋의 결정 대기 건수. key가 바뀔 때마다(화면 이동 · 결정 뒤) 다시 받는다
const openCache = new Map<string, number>()
export function useOpenCount(dataset: string, key: unknown) {
  const [count, setCount] = useState<number | null>(openCache.get(dataset) ?? null)
  useEffect(() => {
    let alive = true
    api(`/api/datasets?id=${dataset}`)
      .then((r) => r.json())
      .then((j: { datasets?: DatasetRow[] }) => {
        const n = j.datasets?.[0]?.summary?.open
        if (alive && typeof n === "number") {
          openCache.set(dataset, n)
          setCount(n)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [dataset, key])
  return count
}
