// 画面で「この操作のボタンを出すか」を決める(本当の確認はサーバー側で行う)。
// 03.60.00 から、役割に加えてメンバーごとの足し引き・チームの設定を含めた自分の権限をサーバーから読む(読み終わるまでは役割で決める)
import { useEffect, useState } from "react";
import { authClient } from "./auth-client";
import { type RoleName, permits } from "./permissions";
import { myPermissions } from "./teams-api";

type Perms = Parameters<typeof authClient.organization.checkRolePermission>[0]["permissions"];

// 同じ画面の中の useCan は 1 回の読み込みを使う(チーム・役割が変わったか、少したったら読み直す)
let cache: { key: string; at: number; p: Promise<Set<string>> } | null = null;
const load = (key: string) => {
  if (!cache || cache.key !== key || Date.now() - cache.at > 10_000) {
    cache = { key, at: Date.now(), p: myPermissions().then((r) => new Set(r.perms)) };
    cache.p.catch(() => { cache = null; });
  }
  return cache.p;
};

export function useCan(userId: string) {
  const { data: team, refetch } = authClient.useActiveOrganization();
  const me = team?.members.find((m) => m.userId === userId);
  const key = me ? `${team!.id}:${userId}:${me.role}` : "";
  const [mine, setMine] = useState<{ key: string; perms: Set<string> } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    load(key).then((perms) => live && setMine({ key, perms }), () => {});
    return () => { live = false; };
  }, [key]);
  const can = (permissions: Perms) => !!me && (mine?.key === key
    ? permits(mine.perms, permissions as Record<string, readonly string[]>)
    : authClient.organization.checkRolePermission({ permissions, role: me.role as RoleName }));
  return { team, me, can, refetch, perms: mine?.key === key ? mine.perms : null };
}
