// テストごとに、Pterodactyl への問い合わせの覚えを捨てる(テストは同じ URL・キーで、違う偽のパネルを使うため)
import { beforeEach } from "vitest";
import { forgetPteroReads } from "../src/server/ptero";

beforeEach(() => forgetPteroReads());
