// CraftShelf のメニューバーのアイコン(macOS。launcher.mjs が起動する。v02 の launcher.py の pystray と同じメニュー)。
//   craftshelf-tray <開く URL> <データの場所> [アイコンの PNG]
// 「終了」を選んだら標準出力に quit と書いて終わる(launcher.mjs がパネルを止める)。標準入力が閉じたら(launcher.mjs が終わったら)これも終わる。
// ビルドは GitHub Actions の macOS(release-v03.yml・image.yml の tray-macos)で、arm64 と x86_64 をまとめて 1 つにする
import AppKit

final class Tray: NSObject {
  let url: URL
  let dir: URL
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

  init(url: URL, dir: URL, icon: String) {
    self.url = url
    self.dir = dir
    super.init()
    if let image = NSImage(contentsOfFile: icon) {
      image.size = NSSize(width: 18, height: 18)
      item.button?.image = image
    } else {
      item.button?.title = "CraftShelf"
    }
    item.button?.toolTip = "CraftShelf"
    let menu = NSMenu()
    for (title, action) in [("CraftShelf を開く", #selector(openPanel)), ("保存先フォルダを開く", #selector(openFolder))] {
      let m = NSMenuItem(title: title, action: action, keyEquivalent: "")
      m.target = self
      menu.addItem(m)
    }
    menu.addItem(.separator())
    let q = NSMenuItem(title: "終了", action: #selector(quit), keyEquivalent: "q")
    q.target = self
    menu.addItem(q)
    item.menu = menu
  }

  @objc func openPanel() { NSWorkspace.shared.open(url) }
  @objc func openFolder() { NSWorkspace.shared.open(dir) }
  @objc func quit() {
    print("quit")
    fflush(stdout)
    NSApp.terminate(nil)
  }
}

let args = CommandLine.arguments
guard args.count >= 3, let url = URL(string: args[1]) else {
  FileHandle.standardError.write("使い方: craftshelf-tray <URL> <データの場所> [アイコンの PNG]\n".data(using: .utf8)!)
  exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // Dock には出さない
let tray = Tray(url: url, dir: URL(fileURLWithPath: args[2]), icon: args.count > 3 ? args[3] : "")
DispatchQueue.global().async {
  while readLine() != nil {}
  DispatchQueue.main.async { NSApp.terminate(nil) }
}
app.run()
