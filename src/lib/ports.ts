// ポート管理の決まりごと(画面とサーバーの両方で使う): 種類の範囲・重複と範囲外の判定・よく使うプラグインの一覧

export type Kind = { id: string; name: string; mode: string; start: number | null; size: number | null; rangeFrom: number | null; rangeTo: number | null; proto: string; file: string; key: string };
export type Group = { id: string; number: string; name: string };
export type Port = { id: string; kindId: string | null; port: number; source: string; file: string; key: string; label: string; memo: string; ignored: boolean };
export type ServerPorts = { id: string; name: string; groupId: string | null; machine: string; ports: Port[] };
export type Problem = { serverId: string; portId: string; port: number; type: "dup" | "out"; message: string; fix: number | null };

export const PORT_MIN = 1;
export const PORT_MAX = 65535;
export const isPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= PORT_MIN && (n as number) <= PORT_MAX;

/** その種類で、そのグループのサーバーが使ってよい範囲(決まっていなければ null) */
export function rangeOf(kind: Kind | undefined, group: Group | undefined): [number, number] | null {
  if (!kind) return null;
  if (kind.mode === "group") {
    if (kind.start == null || !kind.size || !group || !/^\d+$/.test(group.number)) return null;
    const a = kind.start + Number(group.number);
    return [a, a + kind.size - 1];
  }
  if (kind.mode === "fixed" && kind.rangeFrom != null && kind.rangeTo != null) return [kind.rangeFrom, kind.rangeTo];
  return null;
}

// 管理しているポート(「管理から外す」・まだ聞いているものは数えない)
const live = (p: Port) => !p.ignored && p.source !== "found";

/** 同じマシンで同じ番号を使っているもの・範囲の外のもの。直す先の候補(空いている番号)も付ける */
export function findProblems(servers: ServerPorts[], kinds: Kind[], groups: Group[]): Problem[] {
  const kindOf = new Map(kinds.map((k) => [k.id, k]));
  const groupOf = new Map(groups.map((g) => [g.id, g]));
  const used = new Map<string, { serverId: string; port: Port }[]>(); // マシン:番号 → 使っているもの
  for (const s of servers) for (const p of s.ports.filter(live)) {
    const k = `${s.machine}:${p.port}`;
    used.set(k, [...(used.get(k) ?? []), { serverId: s.id, port: p }]);
  }
  const taken = new Set(used.keys());
  const freeIn = (machine: string, r: [number, number] | null) => {
    if (!r) return null;
    for (let n = r[0]; n <= r[1]; n++) if (!taken.has(`${machine}:${n}`)) { taken.add(`${machine}:${n}`); return n; }
    return null;
  };
  const nameOf = new Map(servers.map((s) => [s.id, s.name]));
  const out: Problem[] = [];
  for (const s of servers) {
    for (const p of s.ports.filter(live)) {
      const kind = p.kindId ? kindOf.get(p.kindId) : undefined;
      const r = rangeOf(kind, s.groupId ? groupOf.get(s.groupId) : undefined);
      const others = (used.get(`${s.machine}:${p.port}`) ?? []).filter((u) => u.port.id !== p.id);
      // 重複は、2 つ目以降に出す(1 つ目はそのまま使い続ける想定)
      if (others.length && others.some((u) => u.port.id < p.id)) {
        out.push({ serverId: s.id, portId: p.id, port: p.port, type: "dup", fix: freeIn(s.machine, r),
          message: `${others.map((u) => `${nameOf.get(u.serverId)}${u.port.label ? `(${u.port.label})` : ""}`).join("・")} と同じ番号です` });
      } else if (r && (p.port < r[0] || p.port > r[1])) {
        out.push({ serverId: s.id, portId: p.id, port: p.port, type: "out", fix: freeIn(s.machine, r), message: `${kind!.name} の範囲 ${r[0]}–${r[1]} の外です` });
      }
    }
  }
  return out;
}

/** 空いている番号(その範囲で、同じマシンのどれも使っていないもの) */
export function freePorts(servers: ServerPorts[], machine: string, r: [number, number] | null, n = 3): number[] {
  if (!r) return [];
  const taken = new Set(servers.filter((s) => s.machine === machine).flatMap((s) => s.ports.filter(live).map((p) => p.port)));
  const out: number[] = [];
  for (let x = r[0]; x <= r[1] && out.length < n; x++) if (!taken.has(x)) out.push(x);
  return out;
}

// よく使うプラグインの、ポートを書くファイルと項目(CraftShelf のアップデートで増やす)。* はフォルダー名の一部が版などで変わるもの
export const PORT_CATALOG = [
  { name: "ゲーム", plugin: "サーバー本体", file: "server.properties", key: "server-port", proto: "TCP" },
  { name: "RCON", plugin: "サーバー本体", file: "server.properties", key: "rcon.port", proto: "TCP" },
  { name: "Bedrock", plugin: "Geyser", file: "plugins/Geyser-*/config.yml", key: "bedrock.port", proto: "UDP" },
  { name: "Plan", plugin: "Plan", file: "plugins/Plan/config.yml", key: "Webserver.Port", proto: "TCP" },
  { name: "Voice Chat", plugin: "Simple Voice Chat", file: "plugins/voicechat/voicechat-server.properties", key: "port", proto: "UDP" },
  { name: "BlueMap", plugin: "BlueMap", file: "plugins/BlueMap/webserver.conf", key: "port", proto: "TCP" },
  { name: "Dynmap", plugin: "Dynmap", file: "plugins/dynmap/configuration.txt", key: "webserver-port", proto: "TCP" },
  { name: "Votifier", plugin: "NuVotifier", file: "plugins/Votifier/config.yml", key: "port", proto: "TCP" },
] as const;

// 最初に用意する種類(表の列)。範囲は利用者が決める
export const DEFAULT_KINDS = ["ゲーム", "Bedrock", "Plan", "Voice Chat", "BlueMap", "RCON"].map((name) => {
  const c = PORT_CATALOG.find((x) => x.name === name)!;
  return { name, file: c.file as string, key: c.key as string, proto: c.proto as string };
}).concat([{ name: "そのほか", file: "", key: "", proto: "TCP" }]);
