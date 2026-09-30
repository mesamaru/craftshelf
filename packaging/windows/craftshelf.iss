; CraftShelf の Windows インストーラー(Inno Setup 6)。packaging/build.py から呼び出す。
; 管理者権限は不要で、ユーザーごとにインストールする。保存したデータ(%LOCALAPPDATA%\CraftShelf)は
; アンインストールしても消さない。

#ifndef AppVersion
  #define AppVersion "00.00.00"
#endif
#ifndef AppNumericVersion
  #define AppNumericVersion "0.0.0"
#endif

[Setup]
AppId={{6F2B8C41-3D7A-4E59-9A0B-C8A1F4E2D715}
AppName=CraftShelf
AppVersion={#AppVersion}
AppVerName=CraftShelf {#AppVersion}
VersionInfoVersion={#AppNumericVersion}
AppPublisher=CraftShelf
AppPublisherURL=https://github.com/mesamaru/craftshelf
AppSupportURL=https://github.com/mesamaru/craftshelf/issues
AppUpdatesURL=https://github.com/mesamaru/craftshelf/releases
DefaultDirName={localappdata}\Programs\CraftShelf
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=CraftShelf-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\CraftShelf.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
japanese.StartupTask=Windows の起動時に CraftShelf を開始する
english.StartupTask=Start CraftShelf when Windows starts
japanese.LaunchTask=CraftShelf を起動する
english.LaunchTask=Launch CraftShelf

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "{cm:StartupTask}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; 古い版のファイルが残らないようにする(データは別の場所なので消えない)
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\CraftShelf"; Filename: "{app}\CraftShelf.exe"
Name: "{autodesktop}\CraftShelf"; Filename: "{app}\CraftShelf.exe"; Tasks: desktopicon
Name: "{userstartup}\CraftShelf"; Filename: "{app}\CraftShelf.exe"; Parameters: "--no-browser"; Tasks: startup

[Run]
Filename: "{app}\CraftShelf.exe"; Description: "{cm:LaunchTask}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM CraftShelf.exe"; Flags: runhidden; RunOnceId: "StopCraftShelf"
