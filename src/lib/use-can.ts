// 画面で「この操作のボタンを出すか」を決める(本当の確認はサーバー側で行う)。
// 03.60.00 から、役割に加えてメンバーごとの足し引き・チームの設定を含めた自分の権限をサーバーから読む(読み終わるまでは役割で決める)
import { useEffect, useState } from "react";
import { authClient } from "./auth-client";
import { type RoleName, permits } from "./permissions";
import { shared } from "./shared";
import { myPermissions } from "./teams-api";

type Perms = Parameters<typeof authClient.organization.checkRolePermission>[0]["permissions"];

// 同じ画面の中の useCan は 1 回の読み込みを使う(チーム・役割が変わったか、30 秒たったか、書き込みや「読み直す」があったら読み直す。
// ボタンを出すかを決めるだけで、本当の確認はサーバー側が毎回する)
const load = (key: string) => shared(`perms:${key}`, () => myPermissions().then((r) => new Set(r.perms)), 30_000);

/** 選んでいるチームの ID(まだ分からないあいだは null。チームが無ければ "")。チームが分かってから 1 回だけ読むために使う(未確定 → 確定の 2 回で動かさない) */
export function useTeamKey() {
  const { data, isPending } = authClient.useActiveOrganization();
  return isPending ? null : data?.id ?? "";
}

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
