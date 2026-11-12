import { Link, createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "~/lib/titles";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: pageTitle("プライバシー") }] }),
  component: Privacy,
});

// プライバシーポリシー(サービス版)。公開する前に、運営者が内容を確かめて直す
function Privacy() {
  return (
    <main className="page narrow doc">
      <header className="bar">
        <Link to="/login" className="btn sec sm">‹ 戻る</Link>
        <h1>プライバシーポリシー</h1>
      </header>
      <section className="group"><div className="row column">
        <p>CraftShelf(以下「本サービス」)が扱う情報と、その使い方を説明します。</p>
        <h2>1. 集める情報</h2>
        <ul>
          <li>アカウント: 表示名・メールアドレス・パスワード(元に戻せない形にして保存します)・二段階認証とパスキーの設定</li>
          <li>利用者が登録したもの: チーム・メンバー・サーバーとその設定・Pterodactyl の API キー・ライブラリ・セットなど(API キーやパスワードは暗号化して保存します)</li>
          <li>操作の記録: だれが・いつ・どのサーバーに何をしたか(チームの管理者が見られます)</li>
          <li>ログイン・回数制限のための情報: IP アドレス・ブラウザの種類(セッションと回数制限に使います)</li>
          <li>Cookie: ログインの状態を保つためのものだけを使います。広告・追跡のための Cookie は使いません</li>
        </ul>
        <h2>2. 使い方</h2>
        <p>集めた情報は、本サービスを動かす・不正を防ぐ・問い合わせに答えるためだけに使います。広告には使わず、売りません。</p>
        <h2>3. ほかのサービスとのやりとり</h2>
        <ul>
          <li>Mod・プラグインを探す・入れるときは、Modrinth・SpigotMC(Spiget)・CurseForge に問い合わせます。利用者の個人の情報は送りません</li>
          <li>メール(メールアドレスの確認・パスワードの再設定・招待)は、メールの送信サービス(Resend)を通して送ります。送るのは宛先のメールアドレスと本文だけです</li>
          <li>利用者がつないだ Pterodactyl パネル・サーバーには、利用者が登録した API キーで問い合わせます</li>
        </ul>
        <h2>4. 保存する期間</h2>
        <p>アカウントの情報は、アカウントがあるあいだ保存します。退会の希望があれば、アカウントと、そのアカウントだけが使っていたデータを消します。バックアップに残ったものは、一定の期間ののちに消えます。</p>
        <h2>5. 守り方</h2>
        <p>通信は暗号化し(HTTPS)、パスワード・API キーは元に戻せない形か暗号化して保存します。データベースは、運営者だけが入れる場所に置きます。</p>
        <h2>6. 開示・訂正・削除</h2>
        <p>自分の情報の開示・訂正・削除を求めるときは、「アカウント」の「お問い合わせ・要望」か、GitHub の Issues からご連絡ください。</p>
        <h2>7. 変えるとき</h2>
        <p>この内容を変えるときは、本サービスの中で知らせます。<Link to="/terms">利用規約</Link>もあわせてご覧ください。</p>
      </div></section>
    </main>
  );
}
