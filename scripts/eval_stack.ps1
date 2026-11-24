param(
    [ValidateSet("start", "stop", "status", "restart")]
    [string]$Action = "status",
    [int]$McPort = 25566,
    [string]$Host_ = "127.0.0.1"
)

# 启停评测用的进程组：GPT-SoVITS、Voxkin Studio 和 Minecraft 桥接。
# 桥接以独立模式运行，Agent 不会向玩家索要帮助。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root "work\logs"
$pidFile = Join-Path $root "work\eval_stack.pids.json"
$stackPids = @{}
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Test-Port([int]$Port) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return [bool]$listener
}

function Save-Pids([hashtable]$Pids) {
    $Pids | ConvertTo-Json | Set-Content -Path $pidFile -Encoding utf8
}

function Load-Pids() {
    if (Test-Path $pidFile) {
        try { return Get-Content $pidFile -Raw | ConvertFrom-Json } catch { return @{} }
    }
    return @{}
}

function Start-Tts() {
    $port = 9880
    if (Test-Port $port) { Write-Host "tts already listening on $port"; return }
    $synth = Join-Path $root "work\gpt_sovits_full\GPTheresaV3.2\GPT-SoVITS-v2pro-20250604"
    $python = Join-Path $synth "runtime\python.exe"
    if (-not (Test-Path $python)) { Write-Host "tts runtime missing: $python"; return }
    $process = Start-Process -FilePath $python `
        -ArgumentList "api_v2.py", "-a", "127.0.0.1", "-p", "$port", "-c", "GPT_SoVITS\configs\tts_infer.yaml" `
        -WorkingDirectory $synth `
        -RedirectStandardOutput (Join-Path $logs "tts.out.log") `
        -RedirectStandardError (Join-Path $logs "tts.err.log") `
        -PassThru
    Write-Host "tts started pid=$($process.Id)"
    $stackPids["tts"] = $process.Id
}

function Start-Studio() {
    $port = 8765
    if (Test-Port $port) { Write-Host "studio already listening on $port"; return }
    $python = Join-Path $root ".venv\Scripts\python.exe"
    $env:PYTHONUTF8 = "1"
    $process = Start-Process -FilePath $python `
        -ArgumentList "-m", "voxkin", "serve" `
        -WorkingDirectory $root `
        -RedirectStandardOutput (Join-Path $logs "studio.out.log") `
        -RedirectStandardError (Join-Path $logs "studio.err.log") `
        -PassThru
    Write-Host "studio started pid=$($process.Id)"
    $stackPids["studio"] = $process.Id
}

function Start-Bridge() {
    $env:MC_PORT = "$McPort"
    $env:MC_HOST = $Host_
    $env:VOXKIN_INDEPENDENT = "1"
    $env:PYTHONUTF8 = "1"
    $process = Start-Process -FilePath "node" `
        -ArgumentList "bridge\minecraft_bridge.js" `
        -WorkingDirectory $root `
        -RedirectStandardOutput (Join-Path $logs "bridge.out.log") `
        -RedirectStandardError (Join-Path $logs "bridge.err.log") `
        -PassThru
    Write-Host "bridge started pid=$($process.Id) port=$McPort"
    $stackPids["bridge"] = $process.Id
}

function Stop-Stack() {
    $pids = Load-Pids
    foreach ($name in @("bridge", "studio", "tts")) {
        if ($pids.PSObject.Properties.Name -contains $name) {
            $value = $pids.$name
            Stop-Process -Id $value -Force -ErrorAction SilentlyContinue
            Write-Host "stopped $name pid=$value"
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function Show-Status() {
    foreach ($port in @(9880, 8765, $McPort)) {
        if (Test-Port $port) { Write-Host "port $port listening" } else { Write-Host "port $port closed" }
    }
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/bridge/state" -TimeoutSec 5
        Write-Host ("bridge connected={0} ready={1} age={2}" -f $status.connected, $status.ready, $status.age_s)
    } catch {
        Write-Host "studio not reachable"
    }
}

switch ($Action) {
    "start" {
        Start-Tts
        $ttsDeadline = (Get-Date).AddSeconds(150)
        while ((Get-Date) -lt $ttsDeadline) {
            if (Test-Port 9880) { break }
            Start-Sleep -Seconds 3
        }
        if (-not (Test-Port 9880)) {
            Write-Host "tts not ready; Studio will fall back to silent TTS"
        }
        Start-Studio
        $studioDeadline = (Get-Date).AddSeconds(120)
        while ((Get-Date) -lt $studioDeadline) {
            if (Test-Port 8765) { break }
            Start-Sleep -Seconds 2
        }
        Start-Bridge
        Save-Pids $stackPids
        Start-Sleep -Seconds 5
        Show-Status
    }
    "stop" { Stop-Stack }
    "status" { Show-Status }
    "restart" {
        Stop-Stack
        Start-Sleep -Seconds 2
        & $PSCommandPath -Action start -McPort $McPort -Host_ $Host_
    }
}
