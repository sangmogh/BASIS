// 공유 방 동기화 (주소에 ?room=이름을 붙였을 때만). 같은 방을 연 화면끼리 결정 · 진행 상태 · 인도일 · 이력이 같아진다.
// 회의 화면의 임시값(drafts: 슬라이더 · 담당자 수정 중인 값)은 화면마다 따로 둔다.
// 쓸 때 읽었던 버전을 같이 보내고, 다른 화면이 먼저 썼으면(409) 양쪽 변경을 합쳐 다시 보낸다. 안 보이는 탭은 받아 오지 않는다.
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react"

export type SyncStatus = {
  room: string | null
  status: "off" | "connecting" | "live" | "local" // local: 공유 못 하고 이 브라우저에만 저장
  message?: string
  savedAt?: string
}

const POLL_MS = 3000
const PUSH_MS = 500

export const roomName = (value: string | null) => (value && /^[a-z0-9-]{3,32}$/.test(value) ? value : null)
const shared = <S extends { drafts: unknown }>(s: S) => JSON.stringify({ ...s, drafts: undefined })

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
// 목록 안 항목의 이름표: 실제 일수는 변경+할 일, 그 밖에는 id(호선 · 이벤트) 또는 변경 번호
const keyOf = (x: unknown) =>
  !isObject(x) ? null : typeof x.taskId === "string" ? `${x.code}:${x.taskId}` : typeof x.id === "string" ? x.id : typeof x.code === "string" ? x.code : null
const keyed = (xs: unknown[]) => {
  const keys = xs.map(keyOf)
  return keys.every((k) => k !== null) && new Set(keys).size === keys.length
}

// 3자 합치기: 마지막으로 서버와 맞춘 상태(base)에서 한쪽만 바꾼 건 그쪽을 쓰고, 둘 다 바꾼 건 안쪽까지 내려가 합친다.
// 이름표가 있는 목록(설계변경 · 호선 · 사례)은 항목끼리, 이력처럼 쌓이는 목록은 양쪽에서 새로 생긴 것을 다 남긴다
export function merge3(base: unknown, local: unknown, remote: unknown): unknown {
  if (same(local, base)) return remote
  if (same(remote, base) || same(local, remote)) return local
  if (isObject(local) && isObject(remote)) {
    const b = isObject(base) ? base : {}
    const out: Record<string, unknown> = {}
    new Set([...Object.keys(remote), ...Object.keys(local)]).forEach((k) => {
      const v = merge3(b[k], local[k], remote[k])
      if (v !== undefined) out[k] = v
    })
    return out
  }
  if (Array.isArray(local) && Array.isArray(remote)) {
    const b = Array.isArray(base) ? base : []
    if (keyed(local) && keyed(remote) && keyed(b)) {
      const map = (xs: unknown[]) => new Map(xs.map((x) => [keyOf(x)!, x]))
      const [bm, lm, rm] = [map(b), map(local), map(remote)]
      return [...new Set([...rm.keys(), ...lm.keys()])].map((k) => merge3(bm.get(k), lm.get(k), rm.get(k))).filter((x) => x !== undefined)
    }
    const seen = new Set([...b, ...remote].map((x) => JSON.stringify(x)))
    return [...remote, ...local.filter((x) => !seen.has(JSON.stringify(x)))]
  }
  return local // 같은 값을 양쪽에서 다르게 바꿨으면 이 화면의 것
}

export function useRoomSync<S extends { drafts: unknown }>(
  room: string | null,
  reset: boolean,
  state: S,
  setState: Dispatch<SetStateAction<S>>,
  accept: (remote: unknown) => S | null, // 서버에서 받은 상태가 맞는 형태면 화면 상태로
): SyncStatus {
  const [sync, setSync] = useState<SyncStatus>({ room, status: room ? "connecting" : "off" })
  const latest = useRef(state)
  latest.current = state
  const version = useRef(0)
  const synced = useRef<string | null>(null) // 마지막으로 서버와 맞춘 공유 상태
  const ready = useRef(false)
  const started = useRef(false)
  const busy = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const url = `/api/state?room=${room}`
  const dirty = () => shared(latest.current) !== synced.current

  const notice = (message: string) => {
    setSync((prev) => ({ ...prev, message }))
    setTimeout(() => setSync((prev) => (prev.message === message ? { ...prev, message: undefined } : prev)), 5000)
  }
  const adopt = (remote: S, v: number, savedAt: string) => {
    version.current = v
    synced.current = shared(remote)
    setState((prev) => ({ ...remote, drafts: prev.drafts }))
    setSync({ room, status: "live", savedAt })
  }

  const push = async () => {
    timer.current = null
    if (!ready.current || busy.current || !dirty()) return
    const json = shared(latest.current)
    busy.current = true
    let ok = false
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: `{"baseVersion":${version.current},"state":${json}}`,
      })
      const body = await response.json().catch(() => ({}))
      const remote = response.status === 409 ? accept(body.state) : null
      if (remote) {
        // 다른 화면이 먼저 썼다: 그쪽 변경과 이 화면의 변경을 합쳐 다시 보낸다
        const base = synced.current ? JSON.parse(synced.current) : null
        const merged = accept(merge3(base, JSON.parse(shared(latest.current)), JSON.parse(shared(remote)))) ?? remote
        version.current = body.version
        synced.current = shared(remote)
        setState((prev) => ({ ...merged, drafts: prev.drafts }))
        setSync((prev) => ({ ...prev, room, status: "live", savedAt: body.updatedAt }))
        notice("다른 화면의 변경과 합쳤어요")
        ok = true
      } else if (response.ok) {
        version.current = body.version
        synced.current = json
        setSync((prev) => ({ ...prev, room, status: "live", savedAt: body.updatedAt }))
        ok = true
      } else setSync({ room, status: "local", message: body.error ?? `공유 저장 실패 (${response.status})` })
    } catch {
      setSync({ room, status: "local", message: "공유 서버에 연결하지 못했어요" })
    } finally {
      busy.current = false
    }
    // 보내는 동안 또 바뀐 게 있으면 이어서 보낸다 (실패했으면 다음 변경 때 다시)
    if (ok && dirty()) schedule()
  }
  const schedule = () => {
    if (!timer.current) timer.current = setTimeout(push, PUSH_MS)
  }

  // 처음: 방에 상태가 있으면 받아 오고, 없거나 ?reset이면 지금 상태로 방을 연다
  useEffect(() => {
    if (!room || started.current) return
    started.current = true
    ;(async () => {
      try {
        if (reset) await fetch(url, { method: "DELETE" })
        const response = await fetch(url)
        const body = await response.json()
        if (body.storage === "none") return setSync({ room, status: "local", message: "서버 저장소가 없어 이 브라우저에만 저장돼요" })
        if (!response.ok) throw new Error()
        ready.current = true
        const remote = body.version > 0 ? accept(body.state) : null
        if (remote) adopt(remote, body.version, body.updatedAt)
        else {
          setSync({ room, status: "live" })
          await push()
        }
      } catch {
        setSync({ room, status: "local", message: "공유 서버에 연결하지 못했어요" })
      }
    })()
  }, [])

  // 이 화면에서 바뀌면 보낸다
  useEffect(() => {
    if (room && ready.current && dirty()) schedule()
  }, [state])

  // 다른 화면이 바꾼 것을 받아 온다 (보낼 게 남아 있으면 건너뛰고, 보낼 때 409로 맞춘다)
  useEffect(() => {
    if (!room) return
    const id = setInterval(async () => {
      if (document.visibilityState !== "visible" || !ready.current || busy.current || timer.current || dirty()) return
      try {
        const body = await (await fetch(url)).json()
        if (busy.current || timer.current || dirty() || !(body.version > version.current)) return
        const remote = accept(body.state)
        if (remote) adopt(remote, body.version, body.updatedAt)
      } catch {
        // 다음 차례에 다시
      }
    }, POLL_MS)
    return () => clearInterval(id)
  }, [])

  return sync
}
