# Update (deploy) or roll back the user-local agent-mesh binary on Windows.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/update.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/update.ps1 -Cold
#   powershell -ExecutionPolicy Bypass -File scripts/update.ps1 -Rollback
#   powershell -ExecutionPolicy Bypass -File scripts/update.ps1 -Rollback 20260620-140530
#   powershell -ExecutionPolicy Bypass -File scripts/update.ps1 -List

[CmdletBinding()]
param(
  [switch]$Cold,
  [switch]$Rollback,
  [Parameter(Position = 0)]
  [string]$RollbackTimestamp = "",
  [switch]$List,
  [switch]$Help
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
if (-not $ScriptDir) {
  $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $RepoRoot

function Show-Usage {
  @"
Usage:
  scripts\update.ps1 [-Cold]                    build + deploy latest source, restart service
  scripts\update.ps1 -Rollback [TS] [-Cold]     restore newest (or TS) archived binary, restart
  scripts\update.ps1 -List                      list archived binaries, newest first
  scripts\update.ps1 -Help

Environment:
  MESH_WORK_ROOT       base dir to update (default: user profile); data lives in <base>\.agent-mesh
  MESH_WORK_PORT       backend port to restart (default: 10010)
  MESH_BIN_DIR         local command dir (default: %LOCALAPPDATA%\Programs\agent-mesh\bin)
  MESH_BIN             live binary path (default: %MESH_BIN_DIR%\mesh.exe)
  MESH_BACKUP_DIR      archive dir (default: %LOCALAPPDATA%\agent-mesh\backups)
  MESH_BACKUP_KEEP     archived binaries to keep (default: 5)
  MESH_UPDATE_GATE     run tsc + bun test before building (default: 1; set 0 to skip)

Advanced/test hooks:
  MESH_GATE_CMD        custom verification command
  MESH_BUILD_CMD       custom build command; must write the new binary to %OUT%
  MESH_RESTART_CMD     launcher whose restart subcommand is invoked (default: %MESH_BIN%)
  MESH_HEALTH_TIMEOUT  seconds to wait for /api/state after restart (default: 25)
  MESH_NOW             archive timestamp override
"@
}

function Get-EnvOrDefault([string]$Name, [string]$Default) {
  $Value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrEmpty($Value)) {
    return $Default
  }
  return $Value
}

function Resolve-LocalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "path is empty"
  }
  if ($Path -eq "~") {
    return [IO.Path]::GetFullPath($HOME)
  }
  if ($Path.StartsWith("~/") -or $Path.StartsWith("~\")) {
    return [IO.Path]::GetFullPath((Join-Path $HOME $Path.Substring(2)))
  }
  if ([IO.Path]::IsPathRooted($Path)) {
    return [IO.Path]::GetFullPath($Path)
  }
  return [IO.Path]::GetFullPath((Join-Path (Get-Location) $Path))
}

function Quote-Argument([string]$Value) {
  return "'" + ($Value -replace "'", "''") + "'"
}

function Invoke-ConfiguredCommand([string]$Command, [string]$Label) {
  Write-Host ">> $Command"
  $global:LASTEXITCODE = 0
  Invoke-Expression $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed (exit $LASTEXITCODE)"
  }
}

function Invoke-Launcher([string]$Launcher, [string[]]$Arguments, [string]$Label) {
  $global:LASTEXITCODE = 0
  if (Test-Path -LiteralPath $Launcher) {
    & $Launcher @Arguments
  } else {
    $Line = $Launcher
    foreach ($Argument in $Arguments) {
      $Line += " " + (Quote-Argument $Argument)
    }
    Invoke-Expression $Line
  }
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed (exit $LASTEXITCODE)"
  }
}

function Test-PathContainsDir([string]$Directory) {
  $Needle = [IO.Path]::GetFullPath($Directory).TrimEnd("\", "/")
  foreach ($Entry in (($env:PATH -as [string]) -split ";")) {
    if ([string]::IsNullOrWhiteSpace($Entry)) {
      continue
    }
    try {
      $Candidate = [IO.Path]::GetFullPath($Entry).TrimEnd("\", "/")
    } catch {
      continue
    }
    if ([string]::Equals($Candidate, $Needle, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-BackupFiles {
  if (-not (Test-Path -LiteralPath $BackupDir)) {
    return @()
  }
  return @(Get-ChildItem -LiteralPath $BackupDir -File -Filter "mesh-*.exe" | Sort-Object Name -Descending)
}

function New-ArchivePath([string]$Timestamp) {
  $Candidate = Join-Path $BackupDir "mesh-$Timestamp.exe"
  $Index = 2
  while (Test-Path -LiteralPath $Candidate) {
    $Candidate = Join-Path $BackupDir "mesh-$Timestamp.$Index.exe"
    $Index += 1
  }
  return $Candidate
}

function Wait-Healthy {
  $Deadline = (Get-Date).AddSeconds($HealthTimeout)
  while ((Get-Date) -lt $Deadline) {
    $Code = 0
    try {
      $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/state" -UseBasicParsing -TimeoutSec 3
      $Code = [int]$Response.StatusCode
    } catch {
      if ($_.Exception.Response) {
        $Code = [int]$_.Exception.Response.StatusCode
      }
    }
    if ($Code -ge 100 -and $Code -lt 500) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Restart-AndVerify([string]$What) {
  $Arguments = @("restart", "--root", $Base, "--port", [string]$Port)
  if ($Cold) {
    $Arguments += "--cold"
  }
  Write-Host "restarting: $RestartCmd $($Arguments -join ' ')"
  Invoke-Launcher $RestartCmd $Arguments "restart"
  Write-Host "waiting for backend health on :$Port (up to ${HealthTimeout}s) ..."
  if (Wait-Healthy) {
    Write-Host "OK: $What live and healthy -> http://localhost:$Port  (root $Base\.agent-mesh)"
    return
  }
  Write-Error "backend did not become healthy after $What. Log: $Base\.agent-mesh\backend.log"
}

function Stop-BackendBeforeWindowsSwap {
  if (-not (Test-Path -LiteralPath $Bin)) {
    return
  }
  $Arguments = @("down", "--root", $Base, "--port", [string]$Port)
  if ($Cold) {
    $Arguments += "--cold"
  }
  Write-Host "stopping backend before replacing Windows executable..."
  try {
    Invoke-Launcher $Bin $Arguments "pre-swap stop"
  } catch {
    Write-Warning "pre-swap stop failed: $($_.Exception.Message); continuing to replace if Windows file locks permit it"
  }
}

function Report-Installed([string]$Action) {
  Write-Host "$Action -> $Bin"
  if ([string]::Equals((Split-Path -Leaf $Bin), "mesh.exe", [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-PathContainsDir $BinDir) {
      Write-Host "mesh is available on PATH as: mesh"
    } else {
      Write-Warning "$BinDir is not on PATH; add it to the user PATH before calling 'mesh' directly"
    }
  }
}

function Invoke-Gate {
  if ($Gate -eq "0") {
    return
  }
  Write-Host "-- pre-build gate ------------------------------------------------"
  if ($GateCmd) {
    Invoke-ConfiguredCommand $GateCmd "gate"
  } else {
    & bunx tsc --noEmit
    if ($LASTEXITCODE -ne 0) {
      throw "typecheck failed (exit $LASTEXITCODE)"
    }
    & bun test
    if ($LASTEXITCODE -ne 0) {
      throw "tests failed (exit $LASTEXITCODE)"
    }
  }
  Write-Host "OK: gate passed"
}

function Invoke-Build([string]$OutputPath) {
  Write-Host "-- building new binary -> $OutputPath ---------------------------"
  $OldOut = [Environment]::GetEnvironmentVariable("OUT")
  [Environment]::SetEnvironmentVariable("OUT", $OutputPath, "Process")
  try {
    if ($BuildCmd) {
      Invoke-ConfiguredCommand $BuildCmd "build"
    } else {
      & bun build --compile src/main.ts --outfile $OutputPath
      if ($LASTEXITCODE -ne 0) {
        throw "build failed (exit $LASTEXITCODE)"
      }
    }
  } finally {
    [Environment]::SetEnvironmentVariable("OUT", $OldOut, "Process")
  }
  $Item = Get-Item -LiteralPath $OutputPath
  if ($Item.Length -le 0) {
    throw "build did not produce a non-empty binary at $OutputPath"
  }
}

if ($Help) {
  Show-Usage
  exit 0
}
if ($List -and $Rollback) {
  throw "-List and -Rollback cannot be used together"
}

$LocalAppData = Get-EnvOrDefault "LOCALAPPDATA" (Join-Path $HOME "AppData\Local")
$DefaultBinDir = Join-Path $LocalAppData "Programs\agent-mesh\bin"
$DefaultBackupDir = Join-Path $LocalAppData "agent-mesh\backups"

$Port = [int](Get-EnvOrDefault "MESH_WORK_PORT" "10010")
$Base = Resolve-LocalPath (Get-EnvOrDefault "MESH_WORK_ROOT" $HOME)
$BinDir = Resolve-LocalPath (Get-EnvOrDefault "MESH_BIN_DIR" $DefaultBinDir)
$Bin = Resolve-LocalPath (Get-EnvOrDefault "MESH_BIN" (Join-Path $BinDir "mesh.exe"))
$BinDir = Split-Path -Parent $Bin
$BackupDir = Resolve-LocalPath (Get-EnvOrDefault "MESH_BACKUP_DIR" $DefaultBackupDir)
$Keep = [int](Get-EnvOrDefault "MESH_BACKUP_KEEP" "5")
$Gate = Get-EnvOrDefault "MESH_UPDATE_GATE" "1"
$GateCmd = Get-EnvOrDefault "MESH_GATE_CMD" ""
$BuildCmd = Get-EnvOrDefault "MESH_BUILD_CMD" ""
$RestartCmd = Get-EnvOrDefault "MESH_RESTART_CMD" $Bin
$HealthTimeout = [int](Get-EnvOrDefault "MESH_HEALTH_TIMEOUT" "25")
$Out = Join-Path $BinDir "mesh.new.exe"

try {
  if ($List) {
    $Backups = @(Get-BackupFiles)
    if ($Backups.Count -eq 0) {
      Write-Host "no archived binaries in $BackupDir"
    } else {
      Write-Host "archived binaries in $BackupDir (newest first):"
      foreach ($Backup in $Backups) {
        Write-Host "  $($Backup.Name)"
      }
    }
    exit 0
  }

  if ($Rollback) {
    $Target = $null
    if (-not [string]::IsNullOrWhiteSpace($RollbackTimestamp)) {
      $Target = Join-Path $BackupDir "mesh-$RollbackTimestamp.exe"
      if (-not (Test-Path -LiteralPath $Target)) {
        throw "no such backup: $Target (see: scripts\update.ps1 -List)"
      }
    } else {
      $Newest = @(Get-BackupFiles) | Select-Object -First 1
      if (-not $Newest) {
        throw "no archived binary to roll back to (dir: $BackupDir)"
      }
      $Target = $Newest.FullName
    }

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Stop-BackendBeforeWindowsSwap
    Copy-Item -LiteralPath $Target -Destination $Bin -Force
    if (Test-Path -LiteralPath "$Target.build-id") {
      Copy-Item -LiteralPath "$Target.build-id" -Destination "$Bin.build-id" -Force
    } elseif (Test-Path -LiteralPath "$Bin.build-id") {
      Remove-Item -LiteralPath "$Bin.build-id" -Force
    }
    Report-Installed "restored binary"
    Restart-AndVerify "rollback ($(Split-Path -Leaf $Target))"
    exit 0
  }

  Invoke-Gate

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  if (Test-Path -LiteralPath $Out) {
    Remove-Item -LiteralPath $Out -Force
  }

  Invoke-Build $Out

  $Timestamp = Get-EnvOrDefault "MESH_NOW" (Get-Date -Format "yyyyMMdd-HHmmss")
  $BuildId = Get-EnvOrDefault "MESH_BUILD_ID" $Timestamp
  if (Test-Path -LiteralPath $Bin) {
    $Archive = New-ArchivePath $Timestamp
    Write-Host "archiving current binary -> $Archive"
    Copy-Item -LiteralPath $Bin -Destination $Archive -Force
    if (Test-Path -LiteralPath "$Bin.build-id") {
      Copy-Item -LiteralPath "$Bin.build-id" -Destination "$Archive.build-id" -Force
    }
  }

  Stop-BackendBeforeWindowsSwap
  Move-Item -LiteralPath $Out -Destination $Bin -Force
  Set-Content -LiteralPath "$Bin.build-id" -Value $BuildId
  Report-Installed "installed new binary"

  $Backups = @(Get-BackupFiles)
  for ($Index = $Keep; $Index -lt $Backups.Count; $Index += 1) {
    Write-Host "pruning old backup: $($Backups[$Index].Name)"
    Remove-Item -LiteralPath $Backups[$Index].FullName -Force
    Remove-Item -LiteralPath "$($Backups[$Index].FullName).build-id" -Force -ErrorAction SilentlyContinue
  }

  Restart-AndVerify "new binary"
} finally {
  if (Test-Path -LiteralPath $Out) {
    Remove-Item -LiteralPath $Out -Force
  }
}
