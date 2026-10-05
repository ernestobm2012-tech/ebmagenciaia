; Instalador del lector de impresoras. Lo compila GitHub Actions (.github/workflows/lector-instalador.yml).
; Pide solo la clave del lector, instala sin permisos de administrador y arranca con Windows.
#define AppVersion GetEnv("LECTOR_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6F1C2B7A-9E43-4C1D-8A55-2E7B3D0C9F11}
AppName=Lector de impresoras
AppVersion={#AppVersion}
AppPublisher=EBM Agencia IA
AppPublisherURL=https://ebmagenciaia.es
DefaultDirName={localappdata}\Programs\LectorImpresoras
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
OutputDir=..\salida
OutputBaseFilename=LectorImpresoras-Instalador
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Lector de impresoras
UninstallDisplayIcon={app}\LectorImpresoras.exe

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Messages]
es.WelcomeLabel2=Este programa lee los contadores y el tóner de las impresoras de esta red y los envía a tu panel.%n%nSolo lee contadores: no ve ni guarda ningún documento.%n%nPulsa Siguiente para continuar.
es.FinishedLabel=Listo. El lector ya está funcionando en segundo plano y se encenderá solo cada vez que arranque el ordenador.%n%nEn unos minutos verás las impresoras en tu panel.

[Files]
Source: "..\dist\LectorImpresoras\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{userstartup}\Lector de impresoras"; Filename: "{app}\LectorImpresoras.exe"
Name: "{userprograms}\Lector de impresoras"; Filename: "{app}\LectorImpresoras.exe"

[Run]
Filename: "{app}\LectorImpresoras.exe"; Flags: nowait runasoriginaluser

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM LectorImpresoras.exe"; Flags: runhidden; RunOnceId: "PararLector"

[UninstallDelete]
Type: files; Name: "{app}\lector.txt"

[Code]
var
  KeyPage: TInputQueryWizardPage;

function CleanKey(S: String): String;
begin
  Result := Trim(S);
  if Pos('clave=', Result) = 1 then Result := Trim(Copy(Result, 7, Length(Result)));
end;

function KeyLooksRight(K: String): Boolean;
var I: Integer;
begin
  Result := (Length(K) = 52) and (Copy(K, 1, 4) = 'lec_');
  if Result then
    for I := 5 to 52 do
      if Pos(K[I], '0123456789abcdef') = 0 then Result := False;
end;

procedure InitializeWizard;
var Existing: AnsiString;
begin
  KeyPage := CreateInputQueryPage(wpWelcome,
    'Clave del lector',
    'Pega aquí la clave que te hemos enviado.',
    'Es un texto que empieza por lec_. Sirve para que las lecturas lleguen a tu panel y a nadie más.');
  KeyPage.Add('Clave:', False);
  // Si ya estaba instalado, se rellena sola con la clave que tenía.
  if LoadStringFromFile(ExpandConstant('{localappdata}\Programs\LectorImpresoras\lector.txt'), Existing) then
    KeyPage.Values[0] := CleanKey(Trim(String(Existing)));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var K: String;
begin
  Result := True;
  if CurPageID = KeyPage.ID then
  begin
    K := CleanKey(KeyPage.Values[0]);
    if not KeyLooksRight(K) then
    begin
      MsgBox('Esa clave no está completa. Tiene que empezar por lec_ y tener 52 letras y números. Cópiala otra vez entera y pégala.', mbError, MB_OK);
      Result := False;
    end
    else
      KeyPage.Values[0] := K;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  // Si había una versión anterior funcionando, se para para poder reemplazarla.
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM LectorImpresoras.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\lector.txt'), 'clave=' + KeyPage.Values[0] + #13#10, False);
end;
