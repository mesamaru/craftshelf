// サーバー本体の種類(jar の作り。画面・サーバー・エージェントで共有)。Mod・プラグインの置き場所はサーバーの種類(platforms.ts)で決まり、
// ここでは「どの配布元から、どの jar を取ってくるか」を決める。platform は、このサーバー本体で使うサーバーの種類(無いものは Mod・プラグインを扱わない)
import type { Platform } from "./platforms";

// auto: jar を取ってきて入れ替えられる(false は新しい版があるかの確認だけ。インストーラーが要るもの)
// proxy: Minecraft のバージョンではなく、プロキシの版で配っている
export const SOFTWARE = {
  paper: { label: "Paper", platform: "paper", auto: true, page: "https://papermc.io/downloads/paper" },
  folia: { label: "Folia", platform: "folia", auto: true, page: "https://papermc.io/downloads/folia" },
  purpur: { label: "Purpur", platform: "purpur", auto: true, page: "https://purpurmc.org/downloads" },
  leaf: { label: "Leaf", platform: "paper", auto: true, page: "https://www.leafmc.one/download" },
  pufferfish: { label: "Pufferfish", platform: "paper", auto: true, page: "https://ci.pufferfish.host/" },
  velocity: { label: "Velocity", platform: "velocity", auto: true, proxy: true, page: "https://papermc.io/downloads/velocity" },
  waterfall: { label: "Waterfall", platform: "bungeecord", auto: true, proxy: true, page: "https://papermc.io/downloads/all" },
  bungeecord: { label: "BungeeCord", platform: "bungeecord", auto: true, proxy: true, page: "https://hub.spigotmc.org/jenkins/job/BungeeCord/" },
  fabric: { label: "Fabric", platform: "fabric", auto: true, page: "https://fabricmc.net/use/server/" },
  vanilla: { label: "Vanilla", platform: null, auto: true, page: "https://www.minecraft.net/en-us/download/server" },
  mohist: { label: "Mohist", platform: "forge", auto: true, page: "https://mohistmc.com/download" },
  sponge: { label: "SpongeVanilla", platform: null, auto: true, page: "https://spongepowered.org/downloads/spongevanilla" },
  forge: { label: "Forge", platform: "forge", auto: false, page: "https://files.minecraftforge.net/" },
  neoforge: { label: "NeoForge", platform: "neoforge", auto: false, page: "https://neoforged.net/" },
  quilt: { label: "Quilt", platform: "quilt", auto: false, page: "https://quiltmc.org/en/install/server/" },
  arclight: { label: "Arclight", platform: "forge", auto: false, page: "https://github.com/IzzelAliz/Arclight/releases" },
  spigot: { label: "Spigot", platform: "spigot", auto: false, page: "https://www.spigotmc.org/wiki/buildtools/" },
} as const satisfies Record<string, { label: string; platform: Platform | null; auto: boolean; proxy?: boolean; page: string }>;

export type Software = keyof typeof SOFTWARE;
export const SOFTWARE_IDS = Object.keys(SOFTWARE) as Software[];
export const isSoftware = (v: unknown): v is Software => typeof v === "string" && v in SOFTWARE;
export const isProxy = (s: Software) => "proxy" in SOFTWARE[s];

// jar を取り込ませてよい取得先(配布元の公式のもの。転送先を含む)。Pterodactyl・フォルダのサーバー・エージェントで同じものを使う
export const BUILD_HOSTS = [
  "fill-data.papermc.io", "api.purpurmc.org", "meta.fabricmc.net", "api.leafmc.one", "ci.pufferfish.host", "hub.spigotmc.org",
  "piston-data.mojang.com", "api.mohistmc.com", "mohistmc.com", "repo.spongepowered.org",
];
