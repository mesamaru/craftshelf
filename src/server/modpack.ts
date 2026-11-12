// Modpack からライブラリとセットを作る(v02 の Modパックの読み込み)。
// v03 はファイルを持たないので、Modrinth の .mrpack はファイルの SHA-1 で Modrinth のプロジェクトを、
// CurseForge の Modpack(manifest.json)はプロジェクトの ID を、ライブラリに載せる。サーバーでは動かないもの(env.server が unsupported)は飛ばす
// ライブラリの Modパック(03.58.00 から): 配布元(Modrinth・CurseForge)のいちばん新しい版か、アップロードしたファイルを読んで、同じようにセットを作る
import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { addonSet, addonSetItem, libraryFile, libraryItem, serverFileHistory } from "./db/schema";
import { FILE_LIMITS, cleanPath, editable } from "./files";
import { eventService } from "./events";
import { HttpError, isHttpError, requireTeam } from "./guard";
import { readZipTexts } from "./jar";
import { LIBRARY_LIMITS, fromSource, modTools, packOf } from "./library";
import { CF_HOSTS, curseforgeClient } from "./curseforge";
import { SET_LIMITS, setService } from "./sets";
import { fileStore } from "./uploads";
import type { FetchLike } from "./net";
import { type Deps, remote, serverOf } from "./servers";

export const MODPACK_MAX_BYTES = 100 * 1024 * 1024;
// overrides から書き込むもの: テキストの設定ファイルだけ・300 個まで
const OVERRIDES_MAX = 300;
// Modパックのファイルを取ってくる先(配布元の CDN だけ。CurseForge は別の名前の CDN へ転送することがある)
const PACK_HOSTS = ["cdn.modrinth.com", ...CF_HOSTS];

/** 配布元の CDN から Modパックのファイルを取ってくる(転送は CDN の中だけ、3 回まで。大きすぎるものは断る) */
export async function downloadPack(fetch: FetchLike, url: string) {
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !PACK_HOSTS.includes(u.host)) throw new HttpError(502, "配布元の外のファイルは取ってきません");
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new HttpError(502, "配布元から Modパックのファイルを取ってこられませんでした");
    }
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (to) {
      url = new URL(to, url).toString();
      continue;
    }
    if (!res.ok) throw new HttpError(502, `配布元から Modパックのファイルを取ってこられませんでした(HTTP ${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > MODPACK_MAX_BYTES) throw new HttpError(400, "Modパックのファイルが大きすぎます");
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MODPACK_MAX_BYTES) throw new HttpError(400, "Modパックのファイルが大きすぎます");
    return data;
  }
  throw new HttpError(502, "配布元から Modパックのファイルを取ってこられませんでした(転送が多すぎます)");
}

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
        if (isHttpError(e)) throw e;
        throw new HttpError(400, "Modpack の中身が読めませんでした");
      }
      const uniq = [...new Map(entries.map((e) => [`${e.source}:${e.projectId}`, e])).values()];
      if (!uniq.length) throw new HttpError(400, "ライブラリに載せられる Mod がありませんでした");

      // 名前などをまとめて取る
      const mr = uniq.some((e) => e.source === "modrinth") ? await fromSource(() => tools.modrinth.projects(uniq.filter((e) => e.source === "modrinth").map((e) => e.projectId))) : new Map();
      let cf = new Map<string, { title: string; slug: string; iconUrl: string }>();
      if (uniq.some((e) => e.source === "curseforge")) {
        const key = await tools.cfKeyOf(teamId);
        if (!key) throw new HttpError(400, "CurseForge の Modpack を読むには、設定の「CurseForge API キー」で API キーを設定してください");
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

    /**
     * ライブラリの Modパックから、セットを作る(編集者以上)。配布元のものは受け取る版のとおりのいちばん新しい版を、アップロードしたものはいちばん新しいファイルを読む。
     * serverId を渡すと、設定ファイル(overrides)を書き込み(管理者以上)、セットの中身もそのサーバーに入れる。使った版を覚え、新しい版が出たら知らせる
     */
    async fromItem(headers: Headers, itemId: string, serverId?: string) {
      const { teamId } = await requireTeam(auth, headers, { library: ["edit"] });
      const [i] = await db.select().from(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId)));
      if (!i) throw new HttpError(404, "見つかりません");
      if (i.projectType !== "modpack") throw new HttpError(400, "Modパックではありません");
      let file: { filename: string; data: Uint8Array; id: string; number: string };
      if (i.source === "upload") {
        const [f] = await db.select().from(libraryFile).where(eq(libraryFile.itemId, i.id)).orderBy(desc(libraryFile.createdAt)).limit(1);
        if (!f) throw new HttpError(404, "Modパックのファイルがありません");
        file = { filename: f.filename, data: await fileStore(deps).read(teamId, f), id: f.id, number: f.version || f.filename };
      } else if (i.source === "modrinth" || i.source === "curseforge") {
        const { latest } = await tools.packVersions(teamId, i.source, i.projectId);
        if (!latest?.url) throw new HttpError(404, "ダウンロードできる版がありません(CurseForge は、外部からのダウンロードを許していない版を取ってこられません)");
        file = { filename: latest.filename || `${i.slug || "modpack"}.zip`, data: await downloadPack(deps.fetch, latest.url), id: latest.versionId, number: latest.versionNumber };
      } else {
        throw new HttpError(400, "この配布元の Modパックは読めません");
      }
      const r = await this.import(headers, file.filename, file.data, serverId);
      const st = packOf(i.pack);
      const used = { id: file.id, number: file.number };
      await db.update(libraryItem).set({ pack: JSON.stringify({ used, latest: st?.latest && st.latest.id !== used.id ? st.latest : used }) }).where(eq(libraryItem.id, i.id));
      const applied = serverId ? await setService(deps).apply(headers, r.setId, serverId) : null;
      return { ...r, version: file.number, applied };
    },
  };
}
