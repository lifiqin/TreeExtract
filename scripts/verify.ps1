param(
    [switch]$Integration,
    [switch]$NearestAll,
    [switch]$RequireSymlink,
    [string]$PortableExe = ''
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$desktop = Join-Path $root 'desktop-js'
$dataParent = Split-Path -Parent $root
. (Join-Path $desktop 'scripts\find-dotnet.ps1')

function Require-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
}

function Require-Dataset([string]$Directory) {
    foreach ($name in @('Camera4.zip', 'tree_centers2.txt', 'Metashape.txt',
                        'imgPosList.txt', 'crown.csv', 'trunk.csv', 'manual_marks.csv')) {
        Require-File (Join-Path $Directory $name)
    }
}

function Invoke-Step([string]$Name, [string]$Executable, [string[]]$Arguments) {
    Write-Host "`n=== $Name ==="
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

foreach ($command in @('node', 'npm.cmd', 'powershell.exe')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $command"
    }
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.(\d+)') {
    throw 'Unable to determine the Node.js version.'
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
    throw 'Node.js 22.12.0 or newer is required.'
}
$dotnet = Get-TreeExtractDotnet $root
Require-File (Join-Path $desktop 'node_modules\.bin\prettier.cmd')
$bridge = if ($env:TREEEXTRACT_TEST_BRIDGE) { $env:TREEEXTRACT_TEST_BRIDGE } else {
    Join-Path $desktop 'runtime\TreeExtractorBridge.exe'
}
Require-File $bridge
$bridgePath = (Resolve-Path -LiteralPath $bridge).Path
$runtimeDirectory = Split-Path -Parent $bridgePath

# New desktop tests run in the core gate unless they need these integration fixtures.
$testDirectory = Join-Path $desktop 'tests'
$integrationOnly = @('bridge.test.js', 'build-preservation.test.js', 'crop-export-safety.test.js',
    'dataset-integrity.test.js', 'dual-fallback-baseline.test.js', 'frame-transition.test.js',
    'frame-disambiguation-real.test.js',
    'protocol.test.js', 'species-identity-bridge.test.js')
$integrationTests = @($integrationOnly | ForEach-Object { Join-Path $testDirectory $_ })
foreach ($test in $integrationTests) { Require-File $test }
$coreTests = @(Get-ChildItem -LiteralPath $testDirectory -Filter '*.test.js' -File |
    Where-Object { $_.Name -notin $integrationOnly } | Sort-Object Name | Select-Object -ExpandProperty FullName)
if ($coreTests.Count -eq 0) { throw 'No core JavaScript tests found.' }

if ($Integration -or $NearestAll -or $PortableExe) {
    Require-Dataset (Join-Path $dataParent 'tree')
}
if ($Integration -or $NearestAll) {
    Require-Dataset (Join-Path $dataParent 'dataset_runtime\data')
    Require-Dataset (Join-Path $dataParent 'dataset_runtime_full\data')
    if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
        throw 'tar.exe is required for the real-data tests.'
    }
}
if ($Integration -or $PortableExe) {
    Require-File (Join-Path $desktop 'node_modules\electron\dist\electron.exe')
    Require-File (Join-Path $desktop 'node_modules\playwright\package.json')
}
if ($PortableExe) {
    Require-File $PortableExe
    $resolvedPortableExe = (Resolve-Path -LiteralPath $PortableExe).Path
}

Write-Host "Node: $nodeVersion; .NET SDK: $dotnet"
Write-Host "Runtime under test: $runtimeDirectory"
Write-Host 'The runtime is tested as-is; this script does not rebuild or package it.'
$hadExperimentalSetting = Test-Path Env:TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE
$previousExperimentalSetting = $env:TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE
$hadBridgeOverride = Test-Path Env:TREEEXTRACT_TEST_BRIDGE
$previousBridgeOverride = $env:TREEEXTRACT_TEST_BRIDGE
Push-Location -LiteralPath $desktop
try {
    # Verify production defaults; the physical test script launches its own explicit experiment.
    Remove-Item Env:TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE -ErrorAction SilentlyContinue
    $env:TREEEXTRACT_TEST_BRIDGE = $bridgePath
    Write-Host 'Experimental edge candidates: disabled for the main quality gate.'
    Invoke-Step 'JavaScript core tests' 'node' (@('--test') + $coreTests)
    Invoke-Step 'Independent annotation and evaluation tests' 'node' @('--test',
        (Join-Path $root 'tests\qa-annotations.test.js'), (Join-Path $root 'tests\qa-annotation-core.test.js'),
        (Join-Path $root 'tests\qa-png-evidence.test.js'), (Join-Path $root 'tests\qa-dual-evidence-validation.test.js'))
    Invoke-Step 'JavaScript formatting' 'npm.cmd' @('run', 'format:check')
    $prettier = Join-Path $desktop 'node_modules\.bin\prettier.cmd'
    $qaFormatArgs = @('--config', '.prettierrc.json', '--check', '../tests/qa-annotation*.js',
        '../tests/qa-annotations*.js', '../tests/qa-collect-annotations.js', '../tests/qa-evaluate-annotations.js',
        '../tests/qa-png-evidence*.js', '../tests/qa-dual-evidence*.js', '../tests/qa-pair-*.js',
        '../tests/qa-crop-safety.js', '../tests/annotation/**/*.{js,html,css}')
    Invoke-Step 'QA source formatting' $prettier $qaFormatArgs
    $architectureTest = Join-Path $root 'tests\check_headless.ps1'
    Invoke-Step 'Headless backend architecture' 'powershell.exe' @('-NoProfile', '-ExecutionPolicy',
        'Bypass', '-File', $architectureTest, '-RuntimeDirectory', $runtimeDirectory)
    Invoke-Step 'Backend JSON protocol' 'powershell.exe' @('-NoProfile', '-ExecutionPolicy',
        'Bypass', '-File', (Join-Path $root 'tests\run-modern-tests.ps1'), '-Mode', 'protocol')
    Invoke-Step 'Dataset and annotation integrity' 'powershell.exe' @('-NoProfile', '-ExecutionPolicy',
        'Bypass', '-File', (Join-Path $root 'tests\run-modern-tests.ps1'), '-Mode', 'data-integrity')
    foreach ($script in @('run_algorithm_tests.ps1', 'run_dual_frame_tests.ps1',
                          'run_dual_physical_tests.ps1', 'QA-run-geometry.ps1')) {
        $path = Join-Path $root "tests\$script"
        Invoke-Step $script 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $path)
    }
    $personTest = Join-Path $root 'tests\run_person_head_tests.ps1'
    $personArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $personTest)
    if ($RequireSymlink) { $personArgs += '-RequireSymlink' }
    Invoke-Step 'Person/head and filesystem checks' 'powershell.exe' $personArgs
    if ($Integration) {
        Invoke-Step 'JavaScript and bridge integration tests' 'node' (@('--test') + $integrationTests)
        Invoke-Step 'Electron UI smoke test' 'npm.cmd' @('run', 'test:ui')
        Invoke-Step 'Electron layout smoke test' 'npm.cmd' @('run', 'test:ui:layout')
        Invoke-Step 'Electron merge workflow smoke test' 'npm.cmd' @('run', 'test:ui:merge')
        Invoke-Step 'Electron frame separation smoke test' 'npm.cmd' @('run', 'test:ui:frame-separation')
        Invoke-Step 'Electron real panorama interaction' 'npm.cmd' @('run', 'test:ui:pan')
        Invoke-Step 'Species review with mocked cloud' 'npm.cmd' @('run', 'test:ui:species')
        Invoke-Step 'Offline annotation and pair-review browser tests' 'node' @('--test',
            (Join-Path $root 'tests\qa-annotation-ui.test.js'), (Join-Path $root 'tests\qa-pair-ui.test.js'))
        $dataD1 = Join-Path $dataParent 'tree'
        $zipD1 = Join-Path $dataD1 'Camera4.zip'
        Invoke-Step 'Real crop safety and model-failure checks' 'node' @((Join-Path $root 'tests\qa-crop-safety.js'),
            '--data', $dataD1, '--zip', $zipD1, '--bridge', $bridgePath)
        $dataD2 = Join-Path $dataParent 'dataset_runtime\data'
        $zipD2 = Join-Path $dataD2 'Camera4.zip'
        Invoke-Step 'Real D2 paired-observation evidence' 'node' @((Join-Path $root 'tests\qa-dual-evidence.js'),
            '--data', $dataD2, '--zip', $zipD2, '--bridge', $bridgePath)
    }
    if ($NearestAll) {
        Invoke-Step 'Nearest-frame exhaustive datasets' 'node' @((Join-Path $root 'tests\QA-nearest-all.js'))
    }
    if ($PortableExe) {
        Invoke-Step 'Packaged executable smoke test' 'node' @('tests/portable-smoke.js', $resolvedPortableExe)
    }
}
finally {
    if ($hadExperimentalSetting) { $env:TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE = $previousExperimentalSetting }
    else { Remove-Item Env:TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE -ErrorAction SilentlyContinue }
    if ($hadBridgeOverride) { $env:TREEEXTRACT_TEST_BRIDGE = $previousBridgeOverride }
    else { Remove-Item Env:TREEEXTRACT_TEST_BRIDGE -ErrorAction SilentlyContinue }
    Pop-Location
}

Write-Host "`nRequested verification scripts completed; inspect any SKIP messages above."
if (-not $RequireSymlink) {
    Write-Host 'File-symlink integration is not enforced; use -RequireSymlink on a permitted Windows runner.'
}
if (-not $Integration) { Write-Host 'NOT RUN: full bridge integration and Electron UI.' }
if (-not $NearestAll) { Write-Host 'NOT RUN: exhaustive nearest-frame comparison for all datasets.' }
if (-not $PortableExe) { Write-Host 'NOT RUN: packaged executable smoke test.' }
