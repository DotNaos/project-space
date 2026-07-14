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

[Code]
const
  UserEnvironmentKey = 'Environment';

var
  PreviousProjectPresent: Boolean;
  PreviousConnectorPresent: Boolean;
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
  ConnectorPreserved: Boolean;
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
  ConnectorPreserved := PreserveInstalledFile(
    'project-space-connector.exe',
    'project-space-previous-connector.exe',
    PreviousConnectorPresent
  );
  Result := ProjectPreserved and ConnectorPreserved;
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
  ConnectorRestored: Boolean;
begin
  ProjectRestored := RestoreInstalledFile(
    'project.exe',
    'project-space-previous-project.exe',
    PreviousProjectPresent
  );
  ConnectorRestored := RestoreInstalledFile(
    'project-space-connector.exe',
    'project-space-previous-connector.exe',
    PreviousConnectorPresent
  );
  Result := ProjectRestored and ConnectorRestored;
end;

function RunInstalledProjectSuccessfully(const Arguments: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := RunInstalledProject(Arguments, ResultCode) and (ResultCode = 0);
end;

procedure RollBackFailedConnectorStart();
begin
  if not RunInstalledProjectSuccessfully('connector service stop') then
    RaiseException('The new Project Space connector did not reconnect and could not be stopped. Manual recovery is required.');

  if not RestorePreviousFiles() then
    RaiseException('The new Project Space connector did not reconnect and the previous machine tools could not be restored. Manual recovery is required.');

  if PreviousProjectPresent then
  begin
    if not RunInstalledProjectSuccessfully('connector service start-if-connected') then
      RaiseException('The previous Project Space machine tools were restored, but their connector could not be restarted. Manual recovery is required.');
    RaiseException('The new Project Space connector failed its authenticated reconnect check. The previous machine tools were restored and restarted.');
  end;

  RaiseException('The new Project Space connector failed its authenticated reconnect check. The installation was rolled back.');
end;

procedure StartInstalledConnectorOrRollback();
var
  ResultCode: Integer;
begin
  if not RunInstalledProject('connector service start-if-connected', ResultCode) then
    RollBackFailedConnectorStart();
  if ResultCode <> 0 then
    RollBackFailedConnectorStart();
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
  begin
    StartInstalledConnectorOrRollback();
    AddPathEntry(ExpandConstant('{app}'));
  end;
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
