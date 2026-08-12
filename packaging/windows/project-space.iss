#ifndef MyAppVersion
  #error MyAppVersion must be supplied to ISCC.
#endif

#ifndef SourceDirectory
  #error SourceDirectory must be supplied to ISCC.
#endif

#define MyAppName "Project"
#define MyAppPublisher "DotNaos"
#define MyAppUrl "https://github.com/DotNaos/project-space"
#define MyAppExeName "project.exe"

[Setup]
AppId={{D0B7D247-B537-41B4-9F36-73C61CB16B54}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppUrl}
AppSupportURL={#MyAppUrl}/issues
AppUpdatesURL={#MyAppUrl}/releases
UninstallDisplayName={#MyAppName}
DefaultDirName={localappdata}\Programs\Project Space
DefaultGroupName=Project Space
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#SourceDirectory}
OutputBaseFilename=project-space-machine-tools-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\{#MyAppExeName}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Project Space machine tools
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Files]
Source: "{#SourceDirectory}\project.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDirectory}\project-codex-host.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDirectory}\retire-connector.ps1"; Flags: dontcopy

[InstallDelete]
Type: files; Name: "{app}\project-space-connector.exe"

[Code]
const
  UserEnvironmentKey = 'Environment';

var
  PreviousProjectPresent: Boolean;
  PreviousCodexHostPresent: Boolean;
  PreviousFilesPreserved: Boolean;

function RunInstalledProject(const Arguments: string; var ResultCode: Integer): Boolean;
var
  ProjectExecutable: string;
begin
  ProjectExecutable := ExpandConstant('{app}\project.exe');
  if not FileExists(ProjectExecutable) then
  begin
    ResultCode := 0;
    Result := True;
    exit;
  end;

  Result := Exec(
    ProjectExecutable,
    Arguments,
    ExpandConstant('{app}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
end;

function PreserveInstalledFile(
  const FileName: string;
  const BackupName: string;
  var WasPresent: Boolean
): Boolean;
var
  SourcePath: string;
  BackupPath: string;
begin
  SourcePath := ExpandConstant('{app}\') + FileName;
  BackupPath := ExpandConstant('{tmp}\') + BackupName;
  WasPresent := FileExists(SourcePath);
  if not WasPresent then
  begin
    Result := True;
    exit;
  end;

  if FileExists(BackupPath) then
    DeleteFile(BackupPath);
  Result := FileCopy(SourcePath, BackupPath, False);
end;

function PreservePreviousInstallation(): Boolean;
var
  ProjectPreserved: Boolean;
  CodexHostPreserved: Boolean;
begin
  if PreviousFilesPreserved then
  begin
    Result := True;
    exit;
  end;

  ProjectPreserved := PreserveInstalledFile(
    'project.exe',
    'project-space-previous-project.exe',
    PreviousProjectPresent
  );
  CodexHostPreserved := PreserveInstalledFile(
    'project-codex-host.exe',
    'project-space-previous-codex-host.exe',
    PreviousCodexHostPresent
  );
  Result := ProjectPreserved and CodexHostPreserved;
  if Result then
    PreviousFilesPreserved := True;
end;

function RestoreInstalledFile(
  const FileName: string;
  const BackupName: string;
  const WasPresent: Boolean
): Boolean;
var
  DestinationPath: string;
  BackupPath: string;
begin
  DestinationPath := ExpandConstant('{app}\') + FileName;
  BackupPath := ExpandConstant('{tmp}\') + BackupName;
  if FileExists(DestinationPath) and (not DeleteFile(DestinationPath)) then
  begin
    Result := False;
    exit;
  end;

  if WasPresent then
    Result := FileExists(BackupPath) and FileCopy(BackupPath, DestinationPath, False)
  else
    Result := True;
end;

function RestorePreviousFiles(): Boolean;
var
  ProjectRestored: Boolean;
  CodexHostRestored: Boolean;
begin
  ProjectRestored := RestoreInstalledFile(
    'project.exe',
    'project-space-previous-project.exe',
    PreviousProjectPresent
  );
  CodexHostRestored := RestoreInstalledFile(
    'project-codex-host.exe',
    'project-space-previous-codex-host.exe',
    PreviousCodexHostPresent
  );
  Result := ProjectRestored and CodexHostRestored;
end;

function RunInstalledProjectSuccessfully(const Arguments: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := RunInstalledProject(Arguments, ResultCode) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  ResultCode: Integer;
begin
  Result := '';
  if not PreservePreviousInstallation() then
  begin
    Result := 'The existing Project Space machine tools could not be preserved for rollback. Close them and run the installer again.';
    exit;
  end;
  ExtractTemporaryFile('retire-connector.ps1');
  if not Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{tmp}\retire-connector.ps1') + '"',
    ExpandConstant('{tmp}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) then
  begin
    Result := 'The retired Project Space Connector tasks could not be removed. Close them and run the installer again.';
    exit;
  end;
  if ResultCode <> 0 then
    Result := 'The retired Project Space Connector tasks reported an error while being removed.';
end;

function PathContainsEntry(const PathValue: string; const Entry: string): Boolean;
var
  SearchPath: string;
  SearchEntry: string;
begin
  SearchPath := ';' + Uppercase(PathValue) + ';';
  SearchEntry := ';' + Uppercase(Entry) + ';';
  StringChangeEx(SearchPath, ';;', ';', True);
  Result := Pos(SearchEntry, SearchPath) > 0;
end;

procedure AddPathEntry(const Entry: string);
var
  CurrentPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', CurrentPath) then
    CurrentPath := '';

  if PathContainsEntry(CurrentPath, Entry) then
    exit;

  if (CurrentPath <> '') and (Copy(CurrentPath, Length(CurrentPath), 1) <> ';') then
    CurrentPath := CurrentPath + ';';
  RegWriteExpandStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', CurrentPath + Entry);
end;

function PathWithoutEntry(const PathValue: string; const Entry: string): string;
var
  RemainingPath: string;
  Item: string;
  SeparatorPosition: Integer;
  IsLastSegment: Boolean;
  HasOutputSegment: Boolean;
begin
  RemainingPath := PathValue;
  Result := '';
  HasOutputSegment := False;
  repeat
    SeparatorPosition := Pos(';', RemainingPath);
    IsLastSegment := SeparatorPosition = 0;
    if IsLastSegment then
    begin
      Item := RemainingPath;
      RemainingPath := '';
    end
    else
    begin
      Item := Copy(RemainingPath, 1, SeparatorPosition - 1);
      Delete(RemainingPath, 1, SeparatorPosition);
    end;

    if Uppercase(Item) <> Uppercase(Entry) then
    begin
      if HasOutputSegment then
        Result := Result + ';';
      Result := Result + Item;
      HasOutputSegment := True;
    end;
  until IsLastSegment;
end;

procedure RemovePathEntry(const Entry: string);
var
  CurrentPath: string;
  NewPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', CurrentPath) then
    exit;

  NewPath := PathWithoutEntry(CurrentPath, Entry);
  if NewPath <> CurrentPath then
    RegWriteExpandStringValue(HKEY_CURRENT_USER, UserEnvironmentKey, 'Path', NewPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    AddPathEntry(ExpandConstant('{app}'));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usUninstall then
    exit;

  RemovePathEntry(ExpandConstant('{app}'));
end;
