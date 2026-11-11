// 데이터셋 읽기: db/datasets/<id>.db (SQLite)를 직접 읽는다. Vercel(Node 26)에서도 node:sqlite로 열리는 것 확인 (11/5)
import { existsSync, readdirSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { Tables } from "./basics.js"

export const dataDir = () => resolve(process.env.BASIS_DATA_DIR ?? join(process.cwd(), "db"))

export async function readTablesFromDb(file: string): Promise<Tables> {
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name)
    return Object.fromEntries(names.map((n) => [n, (db.prepare(`SELECT * FROM "${n}"`).all() as Record<string, unknown>[]).map((r) => ({ ...r }))]))
  } finally {
    db.close()
  }
}

// 데이터셋을 어디서 읽었나 (배포 환경 확인용)
const storage = new Map<string, { kind: "sqlite"; file: string }>()
export const storageOf = (id: string) => storage.get(id) ?? null

// 파일 경로(.db) 또는 데이터셋 id
export async function readTables(idOrFile: string): Promise<Tables> {
  if (idOrFile.endsWith(".db")) return readTablesFromDb(idOrFile)
  if (!/^[a-z0-9_-]{1,40}$/i.test(idOrFile)) throw new Error("데이터셋 이름이 맞지 않아요")
  const file = join(dataDir(), "datasets", `${idOrFile}.db`)
  if (!existsSync(file)) throw new Error(`데이터셋이 없어요: ${idOrFile}`)
  const tables = await readTablesFromDb(file)
  storage.set(idOrFile, { kind: "sqlite", file: `db/datasets/${idOrFile}.db` })
  return tables
}

export function datasetIds() {
  const dir = join(dataDir(), "datasets")
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".db"))
        .map((f) => basename(f, ".db"))
        .sort()
    : []
}

// 같은 프로세스 안에서는 한 번 읽은 데이터셋을 다시 쓴다
const cache = new Map<string, Promise<Tables>>()
export function loadTables(id: string) {
  if (!cache.has(id)) cache.set(id, readTables(id).catch((e) => (cache.delete(id), Promise.reject(e))))
  return cache.get(id)!
}
