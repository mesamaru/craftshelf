// サーバーの一覧の並べ替え・絞り込み(src/lib/server-list.ts)
import { describe, expect, it } from "vitest";
import { type ServerItem, arrange, filterServers, sortServers } from "~/lib/server-list";

const s = (name: string, p: Partial<ServerItem> = {}, index = 0): ServerItem => ({ id: name, name, platform: null, mcVersion: null, state: "offline", old: 0, online: 0, index, ...p });
const names = (l: ServerItem[]) => l.map((x) => x.name);
const list = [
  s("サーバー10", { state: "running", online: 3, platform: "paper", mcVersion: "1.21.4" }, 0),
  s("サーバー2", { old: 2, platform: "fabric", mcVersion: "1.20.1" }, 1),
  s("alpha", { state: "running", online: 7, old: 1, platform: "paper", mcVersion: "1.9" }, 2),
  s("Beta", {}, 3),
  s("検証用", { state: "running", platform: "velocity" }, 4),
];

describe("サーバーの並べ替え", () => {
  it("名前順は数字を数として比べ(2 が 10 の前)、大文字小文字を分けない", () => {
    expect(names(sortServers(list, "name"))).toEqual(["alpha", "Beta", "サーバー2", "サーバー10", "検証用"]);
  });
  it("名前の逆順・追加が新しい順(あとから足したものが先)", () => {
    expect(names(sortServers(list, "nameDesc"))).toEqual(["検証用", "サーバー10", "サーバー2", "Beta", "alpha"]);
    expect(names(sortServers(list, "new"))).toEqual(["検証用", "Beta", "alpha", "サーバー2", "サーバー10"]);
  });
  it("稼働中・更新・人数が先。同じものは名前順", () => {
    expect(names(sortServers(list, "running"))).toEqual(["alpha", "サーバー10", "検証用", "Beta", "サーバー2"]);
    expect(names(sortServers(list, "update"))).toEqual(["サーバー2", "alpha", "Beta", "サーバー10", "検証用"]);
    expect(names(sortServers(list, "players"))).toEqual(["alpha", "サーバー10", "Beta", "サーバー2", "検証用"]);
  });
  it("種類順は種類の名前(版は数として)で。種類の無いものは最後", () => {
    expect(names(sortServers([...list, s("無印")], "kind"))).toEqual(["サーバー2", "alpha", "サーバー10", "検証用", "Beta", "無印"]);
  });
  it("元の配列は変えない", () => {
    const before = names(list);
    sortServers(list, "nameDesc");
    expect(names(list)).toEqual(before);
  });
});

describe("サーバーの絞り込み", () => {
  it("名前の一部(大文字小文字を分けない)", () => {
    expect(names(filterServers(list, "BET", "all"))).toEqual(["Beta"]);
    expect(names(filterServers(list, " サーバー ", "all"))).toEqual(["サーバー10", "サーバー2"]);
  });
  it("稼働中・停止中・更新あり", () => {
    expect(names(filterServers(list, "", "running"))).toEqual(["サーバー10", "alpha", "検証用"]);
    expect(names(filterServers(list, "", "stopped"))).toEqual(["サーバー2", "Beta"]);
    expect(names(filterServers(list, "", "update"))).toEqual(["サーバー2", "alpha"]);
  });
});

describe("一覧の組み立て(グループと先頭)", () => {
  it("グループ分けは「対応が必要」(更新あり)と「問題なし」のそれぞれの中を並べ替える", () => {
    const r = arrange(list, { sort: "nameDesc", q: "", filter: "all", group: true });
    expect(names(r.need)).toEqual(["サーバー2", "alpha"]);
    expect(names(r.ok)).toEqual(["検証用", "サーバー10", "Beta"]);
    expect(r.first).toBe("サーバー2");
  });
  it("グループ分けしないときは、全体を 1 つに並べ替える", () => {
    const r = arrange(list, { sort: "name", q: "", filter: "all", group: false });
    expect(r.need).toEqual([]);
    expect(names(r.ok)).toEqual(["alpha", "Beta", "サーバー2", "サーバー10", "検証用"]);
    expect(r.first).toBe("alpha");
  });
  it("絞り込み後に何も無ければ先頭は無い", () => {
    expect(arrange(list, { sort: "name", q: "zzz", filter: "all", group: true }).first).toBeNull();
  });
});
