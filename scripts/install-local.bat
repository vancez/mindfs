@echo off
rem MindFS local installer for Windows.
rem Installs from a locally built .tar.gz (see scripts\build-local.sh) instead
rem of downloading a release from GitHub.
rem
rem Usage:
rem   install-local.bat dist\mindfs_v0.5.8_windows_amd64.tar.gz
rem   install-local.bat dist\mindfs_v0.5.8_windows_amd64.tar.gz -Prefix "%LOCALAPPDATA%\Programs\mindfs"
rem   install-local.bat -Uninstall [-Purge]
setlocal

set "ARCHIVE="
set "UNINSTALL="
set "PURGE="
if defined LOCALAPPDATA (
    set "PREFIX=%LOCALAPPDATA%\Programs\mindfs"
) else (
    set "PREFIX=%USERPROFILE%\AppData\Local\Programs\mindfs"
)

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /I "%ARG%"=="-Prefix" goto opt_prefix
if /I "%ARG%"=="--prefix" goto opt_prefix
if /I "%ARG%"=="-Uninstall" goto opt_uninstall
if /I "%ARG%"=="--uninstall" goto opt_uninstall
if /I "%ARG%"=="-Purge" goto opt_purge
if /I "%ARG%"=="--purge" goto opt_purge
if /I "%ARG%"=="-h" goto usage
if /I "%ARG%"=="--help" goto usage
if defined ARCHIVE goto unknown_arg
set "ARCHIVE=%~f1"
shift
goto parse_args

:opt_prefix
if "%~2"=="" (
    echo Error: -Prefix requires a value. 1>&2
    goto fail_no_temp
)
set "PREFIX=%~2"
shift
shift
goto parse_args

:opt_uninstall
set "UNINSTALL=1"
shift
goto parse_args

:opt_purge
set "PURGE=1"
shift
goto parse_args

:unknown_arg
echo Error: unexpected argument: %ARG% 1>&2
goto usage_error

:args_done
if defined PURGE if not defined UNINSTALL (
    echo Error: -Purge can only be used with -Uninstall. 1>&2
    goto fail_no_temp
)
if defined UNINSTALL goto uninstall
if not defined ARCHIVE (
    echo Error: missing archive argument. 1>&2
    goto usage_error
)
if not exist "%ARCHIVE%" (
    echo Error: archive not found: %ARCHIVE% 1>&2
    goto fail_no_temp
)

set "BIN_DIR=%PREFIX%\bin"
set "SHARE_DIR=%PREFIX%\share\mindfs"
set "RESTART_DIR=%TEMP%\mindfs_restart_%RANDOM%%RANDOM%"
set "MINDFS_BIN_DIR=%BIN_DIR%"
set "MINDFS_RESTART_DIR=%RESTART_DIR%"

rem == Handle a running instance ===============================================
rem Windows locks the image file of a running process, so offer to stop it and
rem relaunch it with the same arguments after installing.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:MINDFS_BIN_DIR.TrimEnd('\'); $p=$d + '\mindfs.exe'; $procs=@(Get-Process -Name mindfs -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $p) }); if($procs.Count -eq 0){ exit 0 }; $dir=$env:MINDFS_RESTART_DIR; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $ids=@(); foreach($proc in $procs){ $ci=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $proc.Id); if(-not $ci -or -not $ci.CommandLine){ exit 3 }; $cmd=$ci.CommandLine.TrimStart(); if($cmd.StartsWith('\"')){ $end=$cmd.IndexOf('\"',1); if($end -lt 1){ exit 3 }; $rest=$cmd.Substring($end+1).TrimStart() } else { if($cmd.Length -lt $p.Length){ exit 3 }; $rest=$cmd.Substring($p.Length).TrimStart() }; [System.IO.File]::WriteAllText((Join-Path $dir ($proc.Id.ToString() + '.args')), $rest, (New-Object System.Text.UTF8Encoding($false))); $ids += $proc.Id }; Write-Host ('MindFS is running (pid ' + ($ids -join ', ') + ').'); exit 2"
if errorlevel 3 (
    echo Error: cannot read the command line of the running MindFS instance. 1>&2
    echo        Stop it manually and re-run this installer: 1>&2
    echo          mindfs --stop 1>&2
    goto fail_no_temp
)
if errorlevel 2 goto running_found
goto no_running_service

:running_found
rem choice reads a single key without waiting for Enter; /N hides the key list
rem so the prompt below carries the [y/N] hint. Errorlevel is 1 for Y, 2 for N.
choice /C YN /N /M "Stop it, install, and restart with the same arguments? [y/N] "
set "STOPNOW=no"
if errorlevel 1 set "STOPNOW=yes"
if errorlevel 2 set "STOPNOW=no"
echo.
if /I not "%STOPNOW%"=="yes" (
    echo Aborted; MindFS was left running.
    goto abort_running
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:MINDFS_BIN_DIR.TrimEnd('\'); $p=$d + '\mindfs.exe'; $procs=@(Get-Process -Name mindfs -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $p) }); foreach($proc in $procs){ & taskkill /PID $proc.Id /T /F | Out-Null }; Start-Sleep -Milliseconds 500; $left=@(Get-Process -Name mindfs -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $p) }); if($left.Count -gt 0){ exit 2 }; exit 0"
if errorlevel 2 (
    echo Error: could not stop MindFS. Stop it manually and re-run this installer: 1>&2
    echo          mindfs --stop 1>&2
    goto abort_running
)

:no_running_service

rem Prefer the Windows built-in bsdtar. A GNU tar from Git/MSYS earlier on
rem PATH reads "D:\..." as a remote host and fails.
set "TAR=%SystemRoot%\System32\tar.exe"
if not exist "%TAR%" (
    set "TAR=tar"
    where tar >nul 2>&1
    if errorlevel 1 (
        echo Error: tar.exe not found; Windows 10 1803+ includes it. 1>&2
        goto fail_no_temp
    )
)

rem == Extract to a temporary directory =======================================
set "WORK=%TEMP%\mindfs_install_%RANDOM%%RANDOM%"
mkdir "%WORK%" >nul 2>&1
if not exist "%WORK%" (
    echo Error: could not create temporary directory: %WORK% 1>&2
    goto fail_no_temp
)

echo Extracting %ARCHIVE%
"%TAR%" -xzf "%ARCHIVE%" -C "%WORK%"
if errorlevel 1 (
    echo Error: failed to extract %ARCHIVE% 1>&2
    echo        Make sure it is a gzip-compressed .tar.gz archive. 1>&2
    goto fail
)

rem Archives contain a single top-level directory named
rem mindfs_<version>_<os>_<arch>. Accept any directory that has the binary.
set "PKG_DIR="
for /d %%D in ("%WORK%\*") do (
    if not defined PKG_DIR if exist "%%D\mindfs.exe" set "PKG_DIR=%%~fD"
)
if not defined PKG_DIR (
    echo Error: archive does not contain mindfs.exe at its root. 1>&2
    echo        Make sure it is a Windows archive built by scripts\build-local.sh. 1>&2
    goto fail
)

for %%D in ("%PKG_DIR%") do set "PKG_NAME=%%~nxD"
set "PKG_VERSION="
set "PKG_OS="
set "PKG_ARCH="
for /f "tokens=1,2,3,4 delims=_" %%A in ("%PKG_NAME%") do (
    set "PKG_VERSION=%%B"
    set "PKG_OS=%%C"
    set "PKG_ARCH=%%D"
)

set "OLD_VERSION="
if exist "%BIN_DIR%\mindfs.exe" (
    for /f "tokens=3" %%V in ('"%BIN_DIR%\mindfs.exe" --version 2^>nul') do set "OLD_VERSION=%%V"
)

if defined OLD_VERSION (
    if defined PKG_VERSION (
        echo Updating mindfs %OLD_VERSION% -^> %PKG_VERSION% from local archive
    ) else (
        echo Updating mindfs %OLD_VERSION% from local archive
    )
) else (
    if defined PKG_VERSION (
        echo Installing mindfs %PKG_VERSION% from local archive
    ) else (
        echo Installing mindfs from local archive
    )
)
echo   Archive: %ARCHIVE%
echo   Prefix:  %PREFIX%

set "HOST_ARCH=amd64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "HOST_ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "HOST_ARCH=amd64"
if defined PKG_OS if /I not "%PKG_OS%"=="windows" echo   Warning: archive is built for %PKG_OS%/%PKG_ARCH%, not windows.
if defined PKG_ARCH if /I not "%PKG_ARCH%"=="%HOST_ARCH%" echo   Warning: archive is built for %PKG_ARCH%, this machine is %HOST_ARCH%.

rem == Install binary =========================================================
mkdir "%BIN_DIR%" >nul 2>&1
copy /y "%PKG_DIR%\mindfs.exe" "%BIN_DIR%\mindfs.exe" >nul
if errorlevel 1 (
    echo Error: failed to copy mindfs.exe to %BIN_DIR% 1>&2
    echo        Stop any running MindFS server and try again. 1>&2
    goto fail
)
echo   Binary  -^> %BIN_DIR%\mindfs.exe

rem == Install default agent config ===========================================
if exist "%PKG_DIR%\agents.json" (
    mkdir "%SHARE_DIR%" >nul 2>&1
    copy /y "%PKG_DIR%\agents.json" "%SHARE_DIR%\agents.json" >nul
    if errorlevel 1 (
        echo Error: failed to copy agents.json to %SHARE_DIR% 1>&2
        goto fail
    )
    echo   Agents  -^> %SHARE_DIR%\agents.json
)
if exist "%PKG_DIR%\task_template.json" (
    mkdir "%SHARE_DIR%" >nul 2>&1
    copy /y "%PKG_DIR%\task_template.json" "%SHARE_DIR%\task_template.json" >nul
    if errorlevel 1 (
        echo Error: failed to copy task_template.json to %SHARE_DIR% 1>&2
        goto fail
    )
    echo   Templates -^> %SHARE_DIR%\task_template.json
)

rem == Install web assets (optional) ==========================================
if exist "%PKG_DIR%\web" (
    if exist "%SHARE_DIR%\web" rd /s /q "%SHARE_DIR%\web"
    mkdir "%SHARE_DIR%" >nul 2>&1
    xcopy "%PKG_DIR%\web" "%SHARE_DIR%\web" /e /i /q /y >nul
    if errorlevel 1 (
        echo Error: failed to copy web assets to %SHARE_DIR%\web 1>&2
        goto fail
    )
    echo   Web     -^> %SHARE_DIR%\web
)

rem == Add to user PATH (if not already present) ==============================
rem Leave a marker inside the prefix only when this installer added the entry,
rem so -Uninstall will not strip a PATH entry that was added by something else.
set "PATH_MARKER=%PREFIX%\.mindfs-path-added"
set "MINDFS_BIN_DIR=%BIN_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:MINDFS_BIN_DIR.TrimEnd('\'); $p=[Environment]::GetEnvironmentVariable('Path','User'); if($null -eq $p){$p=''}; $hit=@($p -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ieq $d }).Count -gt 0; if($hit){ exit 2 }; if($p){$p=$d+';'+$p}else{$p=$d}; [Environment]::SetEnvironmentVariable('Path',$p,'User'); exit 0"
if errorlevel 2 (
    echo   PATH    -^> already contains %BIN_DIR%
) else (
    if errorlevel 1 (
        echo   Warning: could not update the user PATH; add %BIN_DIR% manually. 1>&2
    ) else (
        echo   PATH    -^> added %BIN_DIR% to your user PATH
        >"%PATH_MARKER%" echo Added by install-local.bat
    )
)

rem == Restart the instance(s) that were stopped, with the same arguments ======
if exist "%RESTART_DIR%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:MINDFS_BIN_DIR.TrimEnd('\'); $exe=$d + '\mindfs.exe'; $dir=$env:MINDFS_RESTART_DIR; Get-ChildItem -Path $dir -Filter '*.args' -ErrorAction SilentlyContinue | ForEach-Object { $a=[System.IO.File]::ReadAllText($_.FullName); if($a){ Start-Process -FilePath $exe -ArgumentList $a -WindowStyle Hidden } else { Start-Process -FilePath $exe -WindowStyle Hidden } }"
    if errorlevel 1 (
        echo   Warning: failed to restart MindFS; start it manually. 1>&2
    ) else (
        echo   Restarted MindFS with the same arguments.
    )
    rd /s /q "%RESTART_DIR%" >nul 2>&1
)

rd /s /q "%WORK%" >nul 2>&1
echo.
echo Done. mindfs installed to %BIN_DIR%\mindfs.exe
echo Open a new terminal to use mindfs.
endlocal & set "PATH=%BIN_DIR%;%PATH%" & exit /b 0

:uninstall
set "BIN_DIR=%PREFIX%\bin"
set "SHARE_DIR=%PREFIX%\share\mindfs"
set "PATH_MARKER=%PREFIX%\.mindfs-path-added"
set "PATH_ADDED="
if exist "%PATH_MARKER%" set "PATH_ADDED=1"

echo Uninstalling mindfs
echo   Prefix: %PREFIX%
if exist "%BIN_DIR%\mindfs.exe" del /f /q "%BIN_DIR%\mindfs.exe" >nul 2>&1
if exist "%BIN_DIR%\mindfs.exe" (
    echo   Warning: could not remove %BIN_DIR%\mindfs.exe; stop the running server first. 1>&2
) else (
    echo   Removed binary: %BIN_DIR%\mindfs.exe
)
if exist "%SHARE_DIR%" rd /s /q "%SHARE_DIR%" >nul 2>&1
echo   Removed shared files: %SHARE_DIR%
del /f /q "%PATH_MARKER%" >nul 2>&1
rd "%BIN_DIR%" >nul 2>&1
rd "%PREFIX%\share" >nul 2>&1
rd "%PREFIX%" >nul 2>&1

set "MINDFS_BIN_DIR=%BIN_DIR%"
set "MINDFS_PATH_ADDED=%PATH_ADDED%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:MINDFS_BIN_DIR.TrimEnd('\'); $p=[Environment]::GetEnvironmentVariable('Path','User'); if($null -eq $p){$p=''}; $orig=@($p -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }); $has=@($orig | Where-Object { $_.TrimEnd('\') -ieq $d }).Count -gt 0; if(-not $has){ Write-Host ('  PATH    -> ' + $d + ' is not in the user PATH'); exit 0 }; if($env:MINDFS_PATH_ADDED -ne '1'){ Write-Host ('  PATH    -> kept ' + $d + ' in the user PATH (not added by this installer)'); exit 0 }; $next=@(); $done=$false; foreach($s in $orig){ if(-not $done -and $s.TrimEnd('\') -ieq $d){ $done=$true; continue }; $next+=$s }; [Environment]::SetEnvironmentVariable('Path',($next -join ';'),'User'); Write-Host ('  PATH    -> removed ' + $d + ' from the user PATH')"
if errorlevel 1 echo   Warning: could not update the user PATH; remove %BIN_DIR% manually. 1>&2

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MindFS /f >nul 2>&1
echo   Removed automatic startup entry.

if defined PURGE (
    if exist "%APPDATA%\mindfs" rd /s /q "%APPDATA%\mindfs" >nul 2>&1
    echo   Removed user config: %APPDATA%\mindfs
    echo   Project .mindfs directories were not removed.
) else (
    echo   User config and project .mindfs data were kept.
    echo   Re-run with -Uninstall -Purge to remove user-level MindFS config and logs.
)
echo Done.
exit /b 0

:usage
echo Install MindFS from a locally built archive (see scripts\build-local.sh^).
echo.
echo Usage:
echo   install-local.bat ARCHIVE.tar.gz [-Prefix PATH]
echo   install-local.bat -Uninstall [-Purge] [-Prefix PATH]
echo.
echo Options:
echo   -Prefix PATH   Install prefix (default: %%LOCALAPPDATA%%\Programs\mindfs^).
echo   -Uninstall     Remove the installed binary and shared files.
echo   -Purge         With -Uninstall, also remove user config and logs.
echo   -h, --help     Show this help.
exit /b 0

:usage_error
echo.
echo Run "%~nx0 --help" for usage.
exit /b 1

:abort_running
if defined RESTART_DIR if exist "%RESTART_DIR%" rd /s /q "%RESTART_DIR%" >nul 2>&1
exit /b 1

:fail
rd /s /q "%WORK%" >nul 2>&1
if defined RESTART_DIR if exist "%RESTART_DIR%" rd /s /q "%RESTART_DIR%" >nul 2>&1
exit /b 1

:fail_no_temp
if defined RESTART_DIR if exist "%RESTART_DIR%" rd /s /q "%RESTART_DIR%" >nul 2>&1
exit /b 1
