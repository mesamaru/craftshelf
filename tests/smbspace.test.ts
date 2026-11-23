// SMB の保存先の容量と空き: FileFsFullSizeInformation の読み取りと、QUERY_INFO のやりとり(本物の node-smb2 の Client + メッセージの単位の偽の NAS)
import smb2 from "node-smb2";
import { describe, expect, it } from "vitest";
import { fsFullSize, hookQueryInfo, smbSpace } from "~/server/storage";

const info = (total: bigint, caller: bigint, actual: bigint, spa: number, bps: number) => {
  const b = Buffer.alloc(32);
  b.writeBigInt64LE(total, 0);
  b.writeBigInt64LE(caller, 8);
  b.writeBigInt64LE(actual, 16);
  b.writeUInt32LE(spa, 24);
  b.writeUInt32LE(bps, 28);
  return b;
};

describe("fsFullSize", () => {
  it("割り当て単位 × セクター数 × セクターの大きさ。空きは、この利用者が使える分", () => {
    expect(fsFullSize(info(1000n, 250n, 300n, 8, 512))).toEqual({ total: 4_096_000, free: 1_024_000 });
    expect(fsFullSize(info(976_754_646n, 488_377_323n, 488_377_323n, 8, 512))).toEqual({ total: 976_754_646 * 4096, free: 488_377_323 * 4096 }); // 4 TB 級
  });
  it("使えない数は null(短い・0・負・空きが全体より多い・大きすぎる)", () => {
    expect(fsFullSize(Buffer.alloc(31))).toBeNull();
    expect(fsFullSize(info(1000n, 10n, 10n, 0, 512))).toBeNull();
    expect(fsFullSize(info(0n, 0n, 0n, 8, 512))).toBeNull();
    expect(fsFullSize(info(1000n, -1n, 0n, 8, 512))).toBeNull();
    expect(fsFullSize(info(1000n, 1001n, 0n, 8, 512))).toBeNull();
    expect(fsFullSize(info(2n ** 62n, 1n, 1n, 8, 512))).toBeNull();
  });
});

// 偽の NAS: 送られた枠を読み、CREATE・QUERY_INFO・CLOSE に答える(答えはわざと細かく分けて届ける)
function fakeNas(queryStatus = 0) {
  const client = new smb2.Client("nas.example.test", { requestTimeout: 1000 });
  hookQueryInfo(client);
  const seen: { cmd: number; tree: number; session: string; infoType?: number; cls?: number; fileId?: string }[] = [];
  const fileId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const reply = (req: Buffer, status: number, body: Buffer) => {
    const f = Buffer.alloc(4 + 64 + body.length);
    f.writeUInt32BE(64 + body.length, 0);
    req.copy(f, 4, 4, 68); // 要求のヘッダーをもとに
    f.writeUInt32LE(status, 12);
    f.writeUInt32LE(1, 20); // 答えの印
    body.copy(f, 68);
    // 3 バイト・残りの半分・残り、の 3 回に分けて届ける
    const cut = [3, 3 + Math.floor((f.length - 3) / 2)];
    setTimeout(() => { client.onData(f.subarray(0, cut[0])); client.onData(f.subarray(cut[0], cut[1])); client.onData(f.subarray(cut[1])); }, 1);
  };
  client.connected = true;
  client.socket = {
    write(req: Buffer) {
      const cmd = req.readUInt16LE(16);
      const s = { cmd, tree: req.readUInt32LE(40), session: req.subarray(44, 52).toString("hex") };
      if (cmd === 5) {
        const body = Buffer.alloc(89);
        body.writeUInt16LE(89, 0);
        fileId.copy(body, 64);
        reply(req, 0, body);
      } else if (cmd === 0x10) {
        seen.push({ ...s, infoType: req[70], cls: req[71], fileId: req.subarray(92, 108).toString("hex") });
        if (queryStatus) return reply(req, queryStatus, Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0]));
        const body = Buffer.alloc(8 + 32);
        body.writeUInt16LE(9, 0);
        body.writeUInt16LE(64 + 8, 2);
        body.writeUInt32LE(32, 4);
        info(1000n, 250n, 300n, 8, 512).copy(body, 8);
        reply(req, 0, body);
      } else if (cmd === 6) {
        const body = Buffer.alloc(60);
        body.writeUInt16LE(60, 0);
        reply(req, 0, body);
      }
      if (cmd !== 0x10) seen.push(s);
      return true;
    },
  } as never;
  const session = "0102030405060708";
  const tree = { _id: 7, session: { _id: session }, request: (h: object, b: object) => client.request({ treeId: 7, sessionId: session, ...h } as never, b) };
  return { client, tree: tree as never as Parameters<typeof smbSpace>[1], seen };
}

describe("smbSpace(QUERY_INFO)", () => {
  it("共有のいちばん上を開き、ファイルシステムの情報を聞いて、閉じる", async () => {
    const { client, tree, seen } = fakeNas();
    expect(await smbSpace(client, tree)).toEqual({ total: 4_096_000, free: 1_024_000 });
    expect(seen.map((x) => x.cmd)).toEqual([5, 0x10, 6]);
    expect(seen[1]).toMatchObject({ tree: 7, session: "0102030405060708", infoType: 2, cls: 7, fileId: "00112233445566778899aabbccddeeff" });
  });

  it("NAS が断ったら失敗にする(保存先の画面では「分からない」)。開いたものは閉じる", async () => {
    const { client, tree, seen } = fakeNas(0xc00000bb); // STATUS_NOT_SUPPORTED
    await expect(smbSpace(client, tree)).rejects.toBeTruthy();
    expect(seen.map((x) => x.cmd)).toEqual([5, 0x10, 6]);
  });
});
