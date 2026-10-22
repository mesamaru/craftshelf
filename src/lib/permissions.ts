// チームの役割と権限(画面とサーバーの両方で使う)
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, ownerAc } from "better-auth/plugins/organization/access";

export const statements = {
  ...defaultStatements,
  server: ["create", "update", "delete", "control"], // サーバーの登録・設定・削除・起動と停止
  library: ["edit"], // Mod・プラグインを入れる・外す・更新する
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, server: ["create", "update", "delete", "control"], library: ["edit"] }),
  admin: ac.newRole({ ...adminAc.statements, server: ["create", "update", "delete", "control"], library: ["edit"] }),
  editor: ac.newRole({ server: ["control"], library: ["edit"] }),
  viewer: ac.newRole({}),
};

export type RoleName = keyof typeof roles;

export const ROLE_LABELS: Record<RoleName, string> = {
  owner: "オーナー",
  admin: "管理者",
  editor: "編集者",
  viewer: "閲覧者",
};

// 招待・変更で選べる役割(オーナーは 1 人目だけ。譲るのは別の操作にする)
export const ASSIGNABLE_ROLES: RoleName[] = ["admin", "editor", "viewer"];

export const roleLabel = (r: string) => ROLE_LABELS[r as RoleName] ?? r;
