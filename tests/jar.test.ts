// jar の中の説明ファイルを読む(名前・版・動くサーバーの種類)
import { describe, expect, it } from "vitest";
import { analyzeJar } from "~/server/jar";
import { makeZip } from "./zip";

describe("jar を調べる", () => {
  it("Bukkit のプラグイン(plugin.yml)", () => {
    const j = makeZip({ "plugin.yml": "name: MyPlugin\nversion: '1.2.3'\nmain: a.B\nfolia-supported: true\n", "a/B.class": "x" });
    expect(analyzeJar(j, "MyPlugin.jar")).toEqual({ name: "MyPlugin", version: "1.2.3", projectType: "plugin", loaders: ["bukkit", "spigot", "paper", "purpur", "folia"], mcVersions: [] });
  });

  it("Paper 専用・BungeeCord・Velocity のプラグイン", () => {
    expect(analyzeJar(makeZip({ "paper-plugin.yml": "name: P\nversion: 2\n" }), "p.jar").loaders).toEqual(["paper", "purpur"]);
    expect(analyzeJar(makeZip({ "bungee.yml": "name: B\nversion: 1\n" }), "b.jar").loaders).toEqual(["bungeecord", "waterfall"]);
    expect(analyzeJar(makeZip({ "velocity-plugin.json": '{"id":"v","name":"Vel","version":"3"}' }, false), "v.jar")).toMatchObject({ name: "Vel", version: "3", loaders: ["velocity"] });
  });

  it("Fabric・Forge・NeoForge の Mod", () => {
    expect(analyzeJar(makeZip({ "fabric.mod.json": '{"id":"lithium","name":"Lithium","version":"0.15.0","depends":{"minecraft":">=1.21.1"}}' }), "x.jar"))
      .toEqual({ name: "Lithium", version: "0.15.0", projectType: "mod", loaders: ["fabric", "quilt"], mcVersions: ["1.21.1"] });
    expect(analyzeJar(makeZip({ "META-INF/mods.toml": '[[mods]]\nmodId="jei"\nversion="${file.jarVersion}"\ndisplayName="JEI"\n' }), "jei-1.21.1-19.0.0.jar"))
      .toMatchObject({ name: "JEI", version: "19.0.0", loaders: ["forge"] });
    expect(analyzeJar(makeZip({ "META-INF/neoforge.mods.toml": 'modId="x"\nversion="1.0"\n' }), "x.jar").loaders).toEqual(["neoforge"]);
  });

  it("プラグイン・Mod でないもの・zip でないものは、種類が分からない", () => {
    expect(analyzeJar(makeZip({ "readme.txt": "hi" }), "lib-2.0.jar")).toEqual({ name: "lib", version: "2.0", projectType: null, loaders: [], mcVersions: [] });
    expect(analyzeJar(new TextEncoder().encode("not a zip"), "x.jar").projectType).toBeNull();
  });
});
