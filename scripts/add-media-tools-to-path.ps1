#Requires -Version 5.1
<#
.SYNOPSIS
Adds extracted FFmpeg and Poppler binaries to your user PATH.
.EXAMPLE
.\scripts\add-media-tools-to-path.ps1
.EXAMPLE
.\scripts\add-media-tools-to-path.ps1 -FfmpegPath 'D:\Tools\ffmpeg' -PopplerPath 'D:\Tools\poppler'
.EXAMPLE
.\scripts\add-media-tools-to-path.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$FfmpegPath,
    [string]$PopplerPath
)

$ErrorActionPreference = 'Stop'

function Find-ToolDirectory {
    param([string]$Name, [string]$ExplicitPath, [string[]]$Executables)

    $roots = @()
    if ($ExplicitPath) {
        $roots = @((Get-Item -LiteralPath $ExplicitPath -ErrorAction Stop).FullName)
    } else {
        $roots += "C:\Tools\$Name"
        foreach ($parent in @('C:\Tools', (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Desktop'))) {
            if (Test-Path -LiteralPath $parent -PathType Container) {
                $roots += @(Get-ChildItem -LiteralPath $parent -Directory -Filter "*$Name*" |
                    Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty FullName)
            }
        }
        $installed = Get-Command $Executables[0] -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($installed) { $roots += Split-Path -Parent $installed.Source }
    }

    foreach ($root in ($roots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $candidates = @($root)
        $candidates += @(Get-ChildItem -LiteralPath $root -Filter $Executables[0] -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty DirectoryName -Unique)
        foreach ($candidate in $candidates) {
            $missing = @($Executables | Where-Object { -not (Test-Path -LiteralPath (Join-Path $candidate $_) -PathType Leaf) })
            if ($missing.Count -eq 0) { return (Get-Item -LiteralPath $candidate).FullName }
        }
    }
    throw "Could not find extracted $Name binaries ($($Executables -join ', ')). Extract the ZIP first, then pass -$($Name)Path with its folder."
}

function Add-PathEntry {
    param([AllowNull()][string]$CurrentPath, [string]$Directory)
    foreach ($entry in ($CurrentPath -split ';')) {
        $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"')).TrimEnd('\')
        if ($expanded -ieq $Directory.TrimEnd('\')) { return $CurrentPath }
    }
    if ([string]::IsNullOrEmpty($CurrentPath)) { return $Directory }
    return $CurrentPath.TrimEnd(';') + ';' + $Directory
}

# Validate both installations before changing any environment variables.
$ffmpegBin = Find-ToolDirectory 'Ffmpeg' $FfmpegPath @('ffmpeg.exe', 'ffprobe.exe')
$popplerBin = Find-ToolDirectory 'Poppler' $PopplerPath @('pdftoppm.exe')
Write-Host "FFmpeg: $ffmpegBin"
Write-Host "Poppler: $popplerBin"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$newUserPath = Add-PathEntry (Add-PathEntry $userPath $ffmpegBin) $popplerBin
$newProcessPath = Add-PathEntry (Add-PathEntry $env:Path $ffmpegBin) $popplerBin
if ($PSCmdlet.ShouldProcess('User PATH and current PowerShell PATH', 'Add FFmpeg and Poppler directories')) {
    if ($newUserPath -cne $userPath) {
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    }
    $env:Path = $newProcessPath
    Write-Host 'PATH is ready in this PowerShell window. Restart Codex and other open terminals to pick up the change.'
    Write-Host 'Verify with: ffmpeg -version; ffprobe -version; pdftoppm -v'
}
