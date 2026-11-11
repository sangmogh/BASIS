// 서버 저장소. Vercel KV(Upstash Redis REST)가 연결돼 있으면 그걸 쓰고, 없으면 로컬 개발용 메모리를 쓴다.
// Vercel에서 메모리는 함수 인스턴스마다 따로라 저장소로 쓸 수 없어서, 그때는 "꺼짐"으로 알린다.
const url = () => process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
const token = () => process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN

export type StorageKind = "upstash" | "memory" | "none"
export const storageKind = (): StorageKind => (url() && token() ? "upstash" : process.env.VERCEL ? "none" : "memory")

const memory = new Map<string, string[]>()
const strings = new Map<string, string>()
const expires = new Map<string, number>() // 메모리 저장소의 만료 시각 (kvSetEx)
// 테스트용
export const resetMemory = () => {
  memory.clear()
  strings.clear()
  expires.clear()
  counters.clear()
}

async function redis(command: Array<string | number>): Promise<unknown> {
  const response = await fetch(url()!, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  })
  const body = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string }
  if (!response.ok || body.error) throw new Error(`서버 저장소 오류 (${body.error ?? response.status})`)
  return body.result
}

// 목록 끝에 붙이고, 최대 max개만 남긴다
export async function listPush(key: string, value: unknown, max: number) {
  const text = JSON.stringify(value)
  if (storageKind() === "upstash") {
    await redis(["RPUSH", key, text])
    await redis(["LTRIM", key, -max, -1])
    return
  }
  const list = [...(memory.get(key) ?? []), text]
  memory.set(key, list.slice(-max))
}

// 목록 끝에 붙이기만 한다 (자르지 않음). 붙인 뒤 길이를 돌려준다. Upstash의 RPUSH는 한 번에 처리돼서 동시에 써도 줄이 사라지지 않는다
export async function listAppend(key: string, values: unknown[]): Promise<number> {
  const texts = values.map((v) => JSON.stringify(v))
  if (storageKind() === "upstash") return Number(await redis(["RPUSH", key, ...texts]))
  const list = [...(memory.get(key) ?? []), ...texts]
  memory.set(key, list)
  return list.length
}

export async function listLength(key: string): Promise<number> {
  if (storageKind() === "upstash") return Number(await redis(["LLEN", key]))
  return memory.get(key)?.length ?? 0
}

export async function listAll<T>(key: string): Promise<T[]> {
  const raw = storageKind() === "upstash" ? ((await redis(["LRANGE", key, 0, -1])) as string[]) : (memory.get(key) ?? [])
  return raw.map((x) => JSON.parse(x) as T)
}

export async function listClear(key: string) {
  if (storageKind() === "upstash") await redis(["DEL", key])
  else memory.delete(key)
}

export async function kvGet(key: string): Promise<string | null> {
  if (storageKind() === "upstash") return ((await redis(["GET", key])) as string | null) ?? null
  const until = expires.get(key)
  if (until != null && until <= Date.now()) {
    strings.delete(key)
    expires.delete(key)
    return null
  }
  return strings.get(key) ?? null
}

export async function kvSet(key: string, value: string) {
  if (storageKind() === "upstash") await redis(["SET", key, value])
  else {
    strings.set(key, value)
    expires.delete(key)
  }
}

// 만료 시간이 있는 값 (로그인 세션)
export async function kvSetEx(key: string, value: string, ttlSeconds: number) {
  if (storageKind() === "upstash") await redis(["SET", key, value, "EX", ttlSeconds])
  else {
    strings.set(key, value)
    expires.set(key, Date.now() + ttlSeconds * 1000)
  }
}

export async function kvDel(key: string) {
  if (storageKind() === "upstash") await redis(["DEL", key])
  else {
    strings.delete(key)
    expires.delete(key)
  }
}

// 횟수 세기: KV가 있으면 거기서, 없으면 이 서버 인스턴스 메모리에서 (Vercel에서 KV 없이는 인스턴스마다 따로 센다)
const counters = new Map<string, { count: number; until: number }>()

export async function counterGet(key: string): Promise<number> {
  if (storageKind() === "upstash") return Number((await redis(["GET", key])) ?? 0)
  const c = counters.get(key)
  return c && c.until > Date.now() ? c.count : 0
}

export async function counterAdd(key: string, ttlSeconds: number) {
  if (storageKind() === "upstash") {
    const count = Number(await redis(["INCR", key]))
    if (count === 1) await redis(["EXPIRE", key, ttlSeconds])
    return
  }
  const c = counters.get(key)
  if (c && c.until > Date.now()) c.count++
  else counters.set(key, { count: 1, until: Date.now() + ttlSeconds * 1000 })
}
