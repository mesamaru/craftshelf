// SMB の保存先へ大きいファイルを置くとき: 別の名前(.part)に書いてから名前を変える。失敗しても書きかけが最終の名前で残らない
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { smbStore } from "~/server/storage";

const nas = vi.hoisted(() => ({ files: new Map<string, string>(), failAfter: -1, renames: [] as string[] }));

// 中身がメモリの偽の NAS(node-smb2 の代わり)
vi.mock("node-smb2", () => {
  class Client {
    async authenticate() {
      return {
        connectTree: async () => {
          const tree = {
            openFiles: [] as string[],
            exists: async (p: string) => nas.files.has(p) || p === "lib" || p === "lib/_backup",
            createDirectory: async () => {},
            removeFile: async (p: string) => { nas.files.delete(p); },
            renameFile: async (from: string, to: string) => { nas.renames.push(`${from}>${to}`); nas.files.set(to, nas.files.get(from)!); nas.files.delete(from); },
            createFileWriteStream: async (p: string) => {
              nas.files.set(p, "");
              let n = 0;
              return new Writable({
                write(chunk: Buffer, _e, done) {
                  nas.files.set(p, nas.files.get(p)! + chunk.toString());
                  n += chunk.length;
                  done(nas.failAfter >= 0 && n >= nas.failAfter ? new Error("回線が切れた") : null);
                },
              });
            },
          };
          return tree;
        },
      };
    }
    async close() {}
  }
  return { default: { Client } };
});

const src = join(mkdtempSync(join(tmpdir(), "cs-smb-")), "b.tar.gz");
writeFileSync(src, "x".repeat(5000));
const store = () => smbStore({ host: "nas", share: "s", path: "lib", user: "u", password: "p", domain: "" });

describe("SMB の putFile", () => {
  it("書き終えてから名前を変える(最終の名前は、できあがったものだけ)", async () => {
    nas.files.clear(); nas.renames.length = 0; nas.failAfter = -1;
    await store().putFile("_backup/a.tar.gz", src);
    expect([...nas.files.keys()]).toEqual(["lib/_backup/a.tar.gz"]);
    expect(nas.files.get("lib/_backup/a.tar.gz")).toHaveLength(5000);
    expect(nas.renames).toEqual(["lib/_backup/a.tar.gz.part>lib/_backup/a.tar.gz"]);
  });

  it("途中で失敗したら、書きかけを消す。前からあるものは消さない", async () => {
    nas.files.clear(); nas.renames.length = 0;
    nas.files.set("lib/_backup/old.tar.gz", "前のバックアップ");
    nas.failAfter = 100;
    await expect(store().putFile("_backup/b.tar.gz", src)).rejects.toThrow("書き込めませんでした");
    expect([...nas.files.keys()]).toEqual(["lib/_backup/old.tar.gz"]); // b.tar.gz も b.tar.gz.part も残らない
    nas.failAfter = -1;
  });
});
