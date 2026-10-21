param(
    [Parameter(Mandatory = $true)][string]$TemplateDir,
    [string]$ServerDir = "work/mc/eval_server",
    [int]$Port = 25566,
    [string]$Seed = "20261022"
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Resolve-UnderRoot([string]$path) {
    $full = [IO.Path]::GetFullPath((Join-Path $root $path))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path must stay inside the repository: $full"
    }
    return $full
}

$server = Resolve-UnderRoot $ServerDir
$template = Resolve-UnderRoot $TemplateDir

if ($server -match "\\work\\mc\\server$") {
    throw "Refusing to reset the live server at work/mc/server; pass an isolated -ServerDir"
}
if (-not (Test-Path (Join-Path $template "level.dat"))) {
    throw "Template is missing level.dat: $template"
}
if (-not (Test-Path (Join-Path $server "paper.jar"))) {
    throw "Target server is missing paper.jar: $server"
}
if (-not (Test-Path (Join-Path $server "eula.txt"))) {
    throw "Target server is missing eula.txt: $server"
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw "Port $Port is already in use; stop that server before resetting"
}

foreach ($name in @("world", "world_nether", "world_the_end")) {
    $target = Join-Path $server $name
    if (Test-Path $target) {
        Remove-Item $target -Recurse -Force
    }
}
Copy-Item $template (Join-Path $server "world") -Recurse -Force

$propertiesPath = Join-Path $server "server.properties"
$properties = @{}
if (Test-Path $propertiesPath) {
    foreach ($line in Get-Content $propertiesPath) {
        if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
        $key, $value = $line.Split("=", 2)
        $properties[$key.Trim()] = $value.Trim()
    }
}
$properties["server-port"] = "$Port"
$properties["level-seed"] = $Seed
$properties["difficulty"] = "normal"
$properties["online-mode"] = "false"
$properties["enforce-secure-profile"] = "false"
$properties["spawn-protection"] = "0"
$properties["view-distance"] = "8"
$properties["allow-nether"] = "true"
$properties.GetEnumerator() | Sort-Object Name | ForEach-Object {
    "$($_.Key)=$($_.Value)"
} | Set-Content $propertiesPath -Encoding utf8

Write-Host "Reset complete: $server"
Write-Host "seed=$Seed port=$Port difficulty=normal"
Write-Host "Next: start paper.jar in $server, then launch the bridge with VOXKIN_INDEPENDENT=1"
