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
Source: "{#SourceDirectory}\project-space-connector.exe"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "{app}\project.exe"; Parameters: "connector service start-if-connected"; WorkingDir: "{app}"; StatusMsg: "Restoring the Project Space connector..."; Flags: runhidden waituntilterminated skipifdoesntexist

[Code]
const
  UserEnvironmentKey = 'Environment';

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

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  ResultCode: Integer;
begin
  Result := '';
  if not RunInstalledProject('connector service stop', ResultCode) then
  begin
    Result := 'The existing Project Space connector could not be stopped. Close it and run the installer again.';
    exit;
  end;
  if ResultCode <> 0 then
  begin
    Result := 'The existing Project Space connector reported an error while stopping. Run project connector service stop, then try again.';
  end;
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
    AddPathEntry(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep <> usUninstall then
    exit;

  if not FileExists(ExpandConstant('{app}\project.exe')) then
    RaiseException('Project Space cannot remove connector state because project.exe is missing. Reinstall this version, then uninstall again.');

  { One locked command combines best-effort revocation with local cleanup. }
  if not RunInstalledProject('connector service uninstall', ResultCode) then
    RaiseException('Project Space could not start its local connector cleanup.');
  if ResultCode <> 0 then
    RaiseException('Project Space could not remove its local connector state.');
  RemovePathEntry(ExpandConstant('{app}'));
end;
