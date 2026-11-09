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

// API トークンの範囲(03.57.00 から)。read はどのトークンにも付く。ほかは作るときに選び、作った人の役割を超えられない。
// サーバー側の処理が求める権限から、要る範囲を決める(library の権限 → library、server の control → control、それ以外 → admin)
export const TOKEN_SCOPES = ["read", "library", "control", "admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const SCOPE_LABELS: Record<TokenScope, string> = {
  read: "読む",
  library: "Mod・プラグインを変える(ライブラリ・セット・サーバーのアドオン)",
  control: "サーバーを操作する(起動と停止・コマンド・ログ・ワールドのバックアップ)",
  admin: "管理(サーバーの設定・本体・ファイル・パネルのバックアップ・操作の記録)",
};
// その範囲のトークンを作れる役割(の最低限)
export const SCOPE_ROLE: Record<TokenScope, RoleName> = { read: "viewer", library: "editor", control: "editor", admin: "admin" };
export const isTokenScope = (s: unknown): s is TokenScope => (TOKEN_SCOPES as readonly unknown[]).includes(s);

/** 処理が求める権限に要る範囲 */
export function scopesFor(permissions: Partial<Record<string, readonly string[]>>): TokenScope[] {
  const need = new Set<TokenScope>();
  for (const [k, actions] of Object.entries(permissions)) {
    for (const a of actions ?? []) need.add(k === "library" ? "library" : k === "server" && a === "control" ? "control" : "admin");
  }
  return [...need];
}

/** 役割で作れる範囲か */
export const roleAllowsScope = (role: string, scope: TokenScope) => {
  const order: RoleName[] = ["viewer", "editor", "admin", "owner"];
  const best = Math.max(...role.split(",").map((r) => order.indexOf(r as RoleName)));
  return best >= order.indexOf(SCOPE_ROLE[scope]);
};
export const SCOPE_SHORT: Record<TokenScope, string> = { read: "読む", library: "Mod・プラグイン", control: "サーバーの操作", admin: "管理" };
