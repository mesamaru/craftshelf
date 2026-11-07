// Modpack からライブラリとセットを作る(v02 の Modパックの読み込み)。
// v03 はファイルを持たないので、Modrinth の .mrpack はファイルの SHA-1 で Modrinth のプロジェクトを、
// CurseForge の Modpack(manifest.json)はプロジェクトの ID を、ライブラリに載せる。サーバーでは動かないもの(env.server が unsupported)は飛ばす
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { addonSet, addonSetItem, libraryItem, serverFileHistory } from "./db/schema";
import { FILE_LIMITS, cleanPath, editable } from "./files";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import { readZipTexts } from "./jar";
import { LIBRARY_LIMITS, fromSource, modTools } from "./library";
import { curseforgeClient } from "./curseforge";
import { SET_LIMITS } from "./sets";
import { type Deps, remote, serverOf } from "./servers";

export const MODPACK_MAX_BYTES = 100 * 1024 * 1024;
// overrides から書き込むもの: テキストの設定ファイルだけ・300 個まで
const OVERRIDES_MAX = 300;

type Entry = { source: "modrinth" | "curseforge"; projectId: string };

export function modpackService(deps: Deps) {
  const { db, auth } = deps;

  /**
   * Modpack の overrides(.mrpack は overrides と server-overrides。server-overrides を優先)のテキストの設定ファイルを、サーバーに書き込む。
   * 上書きする前の中身は、設定ファイルの履歴に残す
   */
  async function writeOverrides(target: Awaited<ReturnType<typeof serverOf>>, data: Uint8Array, cfDir: string | null, userId: string) {
    const prefixes = cfDir ? [`${cfDir.replace(/\/+$/, "")}/`] : ["overrides/", "server-overrides/"];
    const all = readZipTexts(data, (n) => prefixes.some((p) => n.startsWith(p)) && !n.endsWith("/")) ?? new Map<string, string>();
    const files = new Map<string, string>();
    let skipped = 0;
    for (const p of prefixes) {
      for (const [n, text] of all) {
        if (!n.startsWith(p)) continue;
        let rel: string;
        try {
          rel = cleanPath(n.slice(p.length));
        } catch {
          skipped++;
          continue;
        }
        if (!rel || !editable(rel) || Buffer.byteLength(text) > FILE_LIMITS.maxBytes) { skipped++; continue; }
        files.set(rel, text); // 後の(server-overrides の)ものを優先
      }
    }
    let written = 0;
    for (const [rel, text] of [...files].slice(0, OVERRIDES_MAX)) {
      const before = await remote(() => target.client.readFile(target.remoteId, rel)).catch(() => null);
      if (before === text) continue;
      await remote(() => target.client.writeFile(target.remoteId, rel, text));
      if (before !== null) await db.insert(serverFileHistory).values({ id: randomUUID(), serverId: target.row.id, path: rel, content: before, savedBy: userId });
      written++;
    }
    return { written, skipped: skipped + Math.max(0, files.size - OVERRIDES_MAX) };
  }
  const tools = modTools(deps);
  const { record } = eventService(deps);

  return {
    /** Modpack(.mrpack・CurseForge の zip)を読み、入っている Mod をライブラリに載せて、同じ名前のセットを作る(編集者以上) */
    async import(headers: Headers, filename: string, data: Uint8Array, serverId?: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      // 設定ファイルを書き込むのは管理者以上(設定ファイルを直すのと同じ)。先に確かめる
      const target = serverId ? (await requireTeam(auth, headers, { server: ["update"] }), await serverOf(deps, who, serverId)) : null;
      if (data.byteLength > MODPACK_MAX_BYTES) throw new HttpError(400, "ファイルが大きすぎます");
      const texts = readZipTexts(data, ["modrinth.index.json", "manifest.json"]);
      if (!texts || (!texts.has("modrinth.index.json") && !texts.has("manifest.json"))) {
        throw new HttpError(400, ".mrpack か、CurseForge の Modpack(manifest.json が入った zip)を選んでください");
      }
      const stem = filename.replace(/\.(mrpack|zip)$/i, "");
      let name = stem;
      const entries: Entry[] = [];
      const missing: string[] = [];
      let skipped = 0;
      try {
        if (texts.has("modrinth.index.json")) {
          const idx = JSON.parse(texts.get("modrinth.index.json")!);
          name = `${idx.name || stem} ${idx.versionId || ""}`.trim();
          const files = ((idx.files ?? []) as { path?: string; hashes?: { sha1?: string }; env?: { server?: string } }[])
            .filter((f) => typeof f.path === "string" && f.path.startsWith("mods/") && !f.path.includes(".."));
          const server = files.filter((f) => f.env?.server !== "unsupported");
          skipped = files.length - server.length;
          const found = await fromSource(() => tools.modrinth.byHashes(server.map((f) => String(f.hashes?.sha1 ?? "")).filter(Boolean)));
          for (const f of server) {
            const hit = found.get(String(f.hashes?.sha1 ?? ""));
            if (hit) entries.push({ source: "modrinth", projectId: hit.projectId });
            else missing.push(f.path!.slice("mods/".length));
          }
        } else {
          const m = JSON.parse(texts.get("manifest.json")!);
          if (!Array.isArray(m.files)) throw new SyntaxError("files");
          name = `${m.name || stem} ${m.version || ""}`.trim();
          for (const f of m.files as { projectID?: unknown }[]) if (Number.isInteger(f.projectID)) entries.push({ source: "curseforge", projectId: String(f.projectID) });
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "Modpack の中身が読めませんでした");
      }
      const uniq = [...new Map(entries.map((e) => [`${e.source}:${e.projectId}`, e])).values()];
      if (!uniq.length) throw new HttpError(400, "ライブラリに載せられる Mod がありませんでした");

      // 名前などをまとめて取る
      const mr = uniq.some((e) => e.source === "modrinth") ? await fromSource(() => tools.modrinth.projects(uniq.filter((e) => e.source === "modrinth").map((e) => e.projectId))) : new Map();
      let cf = new Map<string, { title: string; slug: string; iconUrl: string }>();
      if (uniq.some((e) => e.source === "curseforge")) {
        const key = await tools.cfKeyOf(teamId);
        if (!key) throw new HttpError(400, "CurseForge の Modpack を読むには、「チーム」で CurseForge の API キーを設定してください");
        cf = await fromSource(() => curseforgeClient(deps.fetch, key).projects(uniq.filter((e) => e.source === "curseforge").map((e) => e.projectId)));
      }
      const known = uniq.filter((e) => (e.source === "modrinth" ? mr : cf).has(e.projectId));
      for (const e of uniq) if (!known.includes(e)) missing.push(`${e.source === "modrinth" ? "Modrinth" : "CurseForge"} ${e.projectId}`);

      const [{ n }] = await db.select({ n: count() }).from(libraryItem).where(eq(libraryItem.teamId, teamId));
      const have = new Set((await db.select({ s: libraryItem.source, p: libraryItem.projectId }).from(libraryItem).where(eq(libraryItem.teamId, teamId))).map((r) => `${r.s}:${r.p}`));
      const adding = known.filter((e) => !have.has(`${e.source}:${e.projectId}`)).length;
      if (n + adding > LIBRARY_LIMITS.itemsPerTeam) throw new HttpError(400, `ライブラリに登録できるのは ${LIBRARY_LIMITS.itemsPerTeam} 件までです`);
      const [{ c }] = await db.select({ c: count() }).from(addonSet).where(eq(addonSet.teamId, teamId));
      if (c >= SET_LIMITS.setsPerTeam) throw new HttpError(400, `セットは ${SET_LIMITS.setsPerTeam} 個まで作れます`);

      const itemIds: string[] = [];
      for (const e of known) {
        const info = (e.source === "modrinth" ? mr : cf).get(e.projectId)!;
        itemIds.push(await tools.remember(teamId, user.id, e.source, e.projectId, { ...info, title: info.title || e.projectId, projectType: "mod" }));
      }
      const setId = randomUUID();
      await db.insert(addonSet).values({ id: setId, teamId, name: name.slice(0, 60) || "Modpack", createdBy: user.id });
      const inSet = [...new Set(itemIds)].slice(0, SET_LIMITS.itemsPerSet);
      if (inSet.length) await db.insert(addonSetItem).values(inSet.map((itemId) => ({ setId, itemId })));
      // 取り込んだあとは、ライブラリの同じ名前の項目がそのまま使われる(足しただけ)
      await record({ teamId, userId: user.id, kind: "sets", action: "Modpack から作る", target: name, detail: `${inSet.length} 件${missing.length ? `・見つからないもの ${missing.length} 件` : ""}` });
      const overrides = target ? await writeOverrides(target, data, texts.has("modrinth.index.json") ? null : (() => {
        try { return String(JSON.parse(texts.get("manifest.json")!).overrides || "overrides"); } catch { return "overrides"; }
      })(), user.id) : null;
      if (overrides && target) {
        await record({ teamId, userId: user.id, kind: "admin", action: "Modpack の設定ファイルを書き込む", target: target.row.name, detail: `${name}・${overrides.written} 個` });
      }
      return { name, setId, added: inSet.length, missing, skipped, overrides };
    },
  };
}
