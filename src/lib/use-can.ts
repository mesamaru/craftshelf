// 画面で「この操作のボタンを出すか」を決める(本当の確認はサーバー側で行う)
import { authClient } from "./auth-client";
import type { RoleName } from "./permissions";

type Perms = Parameters<typeof authClient.organization.checkRolePermission>[0]["permissions"];

export function useCan(userId: string) {
  const { data: team, refetch } = authClient.useActiveOrganization();
  const me = team?.members.find((m) => m.userId === userId);
  const can = (permissions: Perms) => !!me && authClient.organization.checkRolePermission({ permissions, role: me.role as RoleName });
  return { team, me, can, refetch };
}
