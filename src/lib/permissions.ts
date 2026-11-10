// チームの役割と権限(画面とサーバーの両方で使う)
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, ownerAc } from "better-auth/plugins/organization/access";

export const statements = {
  ...defaultStatements,
  server: ["create", "update", "delete", "control"], // サーバーの登録・設定・削除・起動と停止
  library: ["edit"], // Mod・プラグインを入れる・外す・更新する
  // 03.60.00 から(それまでは管理者以上の決まり。メンバーごとに足せるように分けた)
  files: ["edit"], // サーバーの設定ファイルを見る・直す
  audit: ["read"], // 操作の記録を見る
  storage: ["manage"], // 保存先(アップロードしたものの置き場所)
  integrations: ["manage"], // Discord への通知・CurseForge の API キー
  panel: ["manage"], // パネルの版の切り替え・利用状況の送信(自分用の版)
} as const;

export const ac = createAccessControl(statements);

const ADMIN_EXTRA = { server: ["create", "update", "delete", "control"], library: ["edit"], files: ["edit"], audit: ["read"], storage: ["manage"], integrations: ["manage"], panel: ["manage"] } as const;
export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, ...ADMIN_EXTRA }),
  admin: ac.newRole({ ...adminAc.statements, ...ADMIN_EXTRA }),
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

// メンバーごとに足し引きできる権限(03.60.00 から。"種類:操作" の形)。役割の権限に足す(allow)・引く(deny)。
// メンバーの招待・役割・チームの設定(Better Auth の member・invitation・organization)は Better Auth が役割だけで確かめるので、ここには入れない
export const GRANTS = [
  "library:edit", "server:control", "files:edit", "server:update", "server:create", "server:delete",
  "audit:read", "storage:manage", "integrations:manage", "panel:manage",
] as const;
export type Grant = (typeof GRANTS)[number];
export const isGrant = (s: unknown): s is Grant => (GRANTS as readonly unknown[]).includes(s);
export const GRANT_LABELS: Record<Grant, string> = {
  "library:edit": "Mod・プラグインを変える(ライブラリ・セット・サーバーのアドオン)",
  "server:control": "サーバーを操作する(起動と停止・コマンド・ログ・ワールドのバックアップ)",
  "files:edit": "サーバーの設定ファイルを見る・直す",
  "server:update": "サーバーの設定(種類・本体・予約・ポート・ワールドを戻す。フォルダのサーバーの起動・停止は管理者以上だけ)",
  "server:create": "サーバーを追加する(Pterodactyl・エージェント。フォルダのサーバーは管理者以上だけ)",
  "server:delete": "サーバーを外す",
  "audit:read": "操作の記録を見る",
  "storage:manage": "保存先を管理する(アップロードしたもの・保存した配布元のファイルの置き場所)",
  "integrations:manage": "連携の設定(Discord への通知・CurseForge の API キー)",
  "panel:manage": "パネルの設定(版の切り替え・自動アップデート・利用状況の送信)",
};

/**
 * できること("種類:操作" の集合): 役割(複数のときは合わせる)の権限 + チームの設定(編集者にも設定ファイル)+ allow − deny。
 * オーナーは減らせない(足し引きを見ない)。allow・deny は GRANTS のものだけを使う
 */
export function permsOf(role: string, o: { allow?: readonly string[]; deny?: readonly string[]; editorFiles?: boolean } = {}): Set<string> {
  const names = role.split(",");
  const out = new Set<string>();
  for (const r of names) {
    for (const [k, acts] of Object.entries((roles[r as RoleName]?.statements ?? {}) as Record<string, readonly string[]>)) for (const a of acts) out.add(`${k}:${a}`);
  }
  if (names.includes("owner")) return out;
  if (o.editorFiles && names.includes("editor")) out.add("files:edit");
  for (const g of o.allow ?? []) if (isGrant(g)) out.add(g);
  for (const g of o.deny ?? []) if (isGrant(g)) out.delete(g);
  return out;
}

/** 求める権限({ server: ["control"] } の形)を、すべて持っているか */
export const permits = (perms: ReadonlySet<string>, need: Partial<Record<string, readonly string[]>>) =>
  Object.entries(need).every(([k, acts]) => (acts ?? []).every((a) => perms.has(`${k}:${a}`)));

// API トークンの範囲(03.57.00 から)。read はどのトークンにも付く。ほかは作るときに選び、作った人の権限を超えられない。
// サーバー側の処理が求める権限から、要る範囲を決める(library の権限 → library、server の control → control、それ以外 → admin)
export const TOKEN_SCOPES = ["read", "library", "control", "admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const SCOPE_LABELS: Record<TokenScope, string> = {
  read: "読む",
  library: "Mod・プラグインを変える(ライブラリ・セット・サーバーのアドオン)",
  control: "サーバーを操作する(起動と停止・コマンド・ログ・ワールドのバックアップ)",
  admin: "管理(サーバーの設定・本体・ファイル・パネルのバックアップ・操作の記録)",
};
// その範囲のトークンを作れる役割(の最低限。メンバーごとに足した権限があれば、その分も作れる)
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

/** その権限(permsOf)で作れる範囲か: その範囲で使える権限を 1 つでも持っていれば作れる(使えるのは、持っている権限の分だけ) */
export const permsAllowScope = (perms: ReadonlySet<string>, scope: TokenScope) =>
  scope === "read" || [...perms].some((p) => scopesFor({ [p.split(":")[0]]: [p.split(":")[1]] })[0] === scope);
export const SCOPE_SHORT: Record<TokenScope, string> = { read: "読む", library: "Mod・プラグイン", control: "サーバーの操作", admin: "管理" };
