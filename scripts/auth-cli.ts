// `npm run auth:schema` 用: Better Auth の CLI に設定だけを渡す(データベースにはつながない)
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuth } from "../src/server/auth";

export const auth = createAuth(drizzle.mock() as never, { appUrl: "http://localhost:3000", secret: "x".repeat(32) });
