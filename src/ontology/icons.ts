// 그래프 점 안에 넣는 선 아이콘 (24×24, 선 굵기 2). 개념(클래스) 이름 → 아이콘
const PATHS: Record<string, string> = {
  change: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 16.5 14.5 11l2 2L11 18.5H9z"/>',
  series: '<path d="M12 3 2 8l10 5 10-5z"/><path d="m2 13 10 5 10-5"/>',
  hull: '<path d="M3 14h18l-2.5 6h-13z"/><path d="M6 14V9h12v5"/><path d="M12 9V4"/><path d="M9 6h6"/>',
  block: '<path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="m3.5 7 8.5 4.5L20.5 7"/><path d="M12 11.5v10"/>',
  part: '<path d="M12 2.5 4 7v10l8 4.5 8-4.5V7z"/><circle cx="12" cy="12" r="3"/>',
  revision: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  clipboard: '<rect x="5.5" y="4" width="13" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M9 11h6M9 15h4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  package: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/><path d="m7.5 5.5 9 5"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.5 11h11l2-8H6.5"/>',
  inbox: '<path d="M3 13h5l1 3h6l1-3h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  building: '<rect x="4.5" y="3" width="15" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  book: '<path d="M3 4.5h6a3 3 0 0 1 3 3V20a2.5 2.5 0 0 0-2.5-2.5H3z"/><path d="M21 4.5h-6a3 3 0 0 0-3 3V20a2.5 2.5 0 0 1 2.5-2.5H21z"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  signed: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m9 15 2 2 4-4"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  chart: '<path d="M5 20V11M11 20V5M17 20v-7M3 20h18"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  gavel: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  factory: '<path d="M3 21V10l6 4v-4l6 4V6l6 3v12z"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M5 3v5h5M19 21v-5h-5"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
}

const BY_CLASS: Record<string, keyof typeof PATHS> = {
  DesignChange: "change",
  Series: "series",
  Hull: "hull",
  HullContract: "signed",
  HullMilestone: "flag",
  HullProgress: "chart",
  HullDeliveryPath: "chart",
  Block: "block",
  BlockWindow: "calendar",
  Part: "part",
  PartRevision: "revision",
  PartOccurrence: "pin",
  ProductionItem: "wrench",
  Operation: "wrench",
  WorkOrder: "clipboard",
  ProductionEvent: "activity",
  Inspection: "check",
  ResourceGroup: "factory",
  ResourceAvailability: "factory",
  Material: "package",
  MaterialAllocation: "package",
  ChangeMaterial: "package",
  SupplierQuote: "receipt",
  SupplierQuoteLine: "receipt",
  PurchaseOrder: "cart",
  PurchaseLine: "cart",
  PoSchedule: "calendar",
  GoodsReceipt: "inbox",
  Employee: "user",
  Counterparty: "building",
  Department: "users",
  PastCase: "book",
  EngineeringSolution: "bulb",
  OwnerPreference: "sliders",
  DecisionRecord: "gavel",
  TaskConfirmation: "check",
  TaskProgress: "check",
  TaskTemplate: "clipboard",
  SystemEvent: "sync",
  SystemSync: "sync",
  Zone: "map",
  CostRate: "hash",
  DurationDefault: "hash",
  WorkStandard: "hash",
  PayerRule: "hash",
  ContractChangeTerm: "signed",
}

const cache = new Map<string, string>()
// 점 배경에 넣을 data URI. cls = 개념 이름(local name), 용어는 "concept"
export function iconUri(cls: string, color: string) {
  const key = `${cls}|${color}`
  let uri = cache.get(key)
  if (!uri) {
    const path = PATHS[cls === "concept" ? "tag" : (BY_CLASS[cls] ?? "dot")]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
    uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    cache.set(key, uri)
  }
  return uri
}

// 왼쪽 목록 · 상세 머리에 쓰는 인라인 아이콘
export function iconSvg(cls: string) {
  return PATHS[cls === "concept" ? "tag" : (BY_CLASS[cls] ?? "dot")]
}
