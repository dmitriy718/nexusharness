#requires -Version 5.1

<#
.SYNOPSIS
Idempotently prepares and starts NexusHarness on Windows.

.DESCRIPTION
Validates or installs Node LTS, restores dependencies from package-lock.json,
repairs generated dependencies when requested, builds NexusHarness, applies
memory-vector migrations, runs an isolated smoke check, and starts the local
production server. Persistent NexusHarness data is never automatically reset.

.PARAMETER NoStart
Prepare and verify the deployment without starting NexusHarness.

.PARAMETER Dev
Start the API and Vite development servers after preparation.

.PARAMETER SkipSmoke
Skip the isolated production smoke check.

.PARAMETER Repair
Force npm ci even when the dependency fingerprint is already healthy.

.PARAMETER NoNodeInstall
Fail with instructions instead of installing Node LTS through winget.

.PARAMETER Port
Production/API loopback port. Defaults to 8787.

.PARAMETER DataDir
Persistent NexusHarness data directory. Defaults to .nexusharness in the repository.

.EXAMPLE
.\quickstart.ps1

.EXAMPLE
.\quickstart.ps1 -NoStart -Repair

.EXAMPLE
.\quickstart.ps1 -Port 9000 -DataDir D:\NexusData
#>

[CmdletBinding()]
param(
    [switch]$NoStart,
    [switch]$Dev,
    [switch]$SkipSmoke,
    [switch]$Repair,
    [switch]$NoNodeInstall,
    [ValidateRange(1, 65535)]
    [int]$Port = 8787,
    [string]$DataDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$script:ScriptVersion = "1.0.0"
$script:MinimumNodeMajor = 20
$script:DefaultPort = 8787
$script:RootDir = [IO.Path]::GetFullPath($PSScriptRoot)
$script:NodeExe = ""
$script:NpmExe = ""
$script:ChildProcess = $null

function Write-Log {
    param(
        [Parameter(Mandatory)] [string]$Level,
        [Parameter(Mandatory)] [string]$Message,
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )
    $stamp = Get-Date -Format "HH:mm:ss"
    Write-Host "[$stamp] [$($Level.PadRight(4))] $Message" -ForegroundColor $Color
}

function Write-Info([string]$Message) { Write-Log -Level "INFO" -Message $Message -Color Cyan }
function Write-Success([string]$Message) { Write-Log -Level " OK " -Message $Message -Color Green }
function Write-WarningLog([string]$Message) { Write-Log -Level "WARN" -Message $Message -Color Yellow }

function Show-Banner {
    Write-Host @'
     _   _ ________  ___   _ _____
    | \ | |  ___\  \/  |  | /  ___|
    |  \| | |__  \  / /|  | \ `--.
    | . ` |  __| /  \ \|  | |`--. \
    | |\  | |___/ /\  \ |/ /\__/ /
    \_| \_/____/\/  \/\___/\____/
'@ -ForegroundColor Cyan
    Write-Host "        H A R N E S S   W I N D O W S   Q U I C K S T A R T" -ForegroundColor Magenta
    Write-Host "`nLocal-first. Auditable. Ready to build.`n" -ForegroundColor DarkGray
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [Parameter()] [string[]]$ArgumentList = @(),
        [Parameter()] [string]$Description = $FilePath
    )
    Write-Info "+ $Description"
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = @($user, $machine, $env:Path) -join ";"
}

function Resolve-RuntimeCommands {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($node) { $script:NodeExe = $node.Source }
    if ($npm) { $script:NpmExe = $npm.Source }
}

function Get-NodeMajor {
    if (-not $script:NodeExe) { return 0 }
    $value = & $script:NodeExe -p process.versions.node 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $value) { return 0 }
    $major = ([string]$value).Split(".")[0]
    if (-not ($major -as [int])) { return 0 }
    return [int]$major
}

function Install-NodeLts {
    if ($NoNodeInstall) {
        throw "Node.js $($script:MinimumNodeMajor)+ is required and automatic installation is disabled."
    }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "Node.js $($script:MinimumNodeMajor)+ is required. Install Node LTS from https://nodejs.org/ because winget is unavailable."
    }

    Write-WarningLog "Node.js is missing or too old; installing user-scoped Node LTS through winget."
    $wingetArguments = @(
        "install", "--id", "OpenJS.NodeJS.LTS", "--exact", "--scope", "user", "--force",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
    )
    try {
        Invoke-Native -FilePath $winget.Source -ArgumentList $wingetArguments -Description "winget install user-scoped OpenJS.NodeJS.LTS"
    } catch {
        Write-WarningLog "The user-scoped Node installer was unavailable; retrying the official winget package, which may request elevation."
        Invoke-Native -FilePath $winget.Source -ArgumentList @(
            "install", "--id", "OpenJS.NodeJS.LTS", "--exact", "--force",
            "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
        ) -Description "winget install OpenJS.NodeJS.LTS"
    }
    Refresh-ProcessPath
    Resolve-RuntimeCommands
    if (-not $script:NodeExe -or -not $script:NpmExe) {
        throw "Node LTS was installed, but node.exe/npm.cmd are not visible yet. Open a new PowerShell window and rerun quickstart.ps1."
    }
}

function Ensure-Node {
    Resolve-RuntimeCommands
    $major = Get-NodeMajor
    if ($major -lt $script:MinimumNodeMajor -or -not $script:NpmExe) {
        Install-NodeLts
        $major = Get-NodeMajor
    }
    if ($major -lt $script:MinimumNodeMajor) {
        throw "Node.js $($script:MinimumNodeMajor)+ is required."
    }
    $nodeVersion = (& $script:NodeExe --version).Trim()
    $npmVersion = (& $script:NpmExe --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw "npm version detection failed." }
    Write-Success "Runtime ready: Node $nodeVersion, npm $npmVersion"
}

function Confirm-Repository {
    Set-Location -LiteralPath $script:RootDir
    foreach ($required in @("package.json", "package-lock.json", "server\index.ts")) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:RootDir $required) -PathType Leaf)) {
            throw "Run this script from a complete NexusHarness checkout; missing $required."
        }
    }
    Write-Success "Repository detected at $($script:RootDir)"
}

function Initialize-DataDirectory {
    if (-not $DataDir) {
        $script:DataDirectory = Join-Path $script:RootDir ".nexusharness"
    } elseif ([IO.Path]::IsPathRooted($DataDir)) {
        $script:DataDirectory = [IO.Path]::GetFullPath($DataDir)
    } else {
        $script:DataDirectory = [IO.Path]::GetFullPath((Join-Path $script:RootDir $DataDir))
    }
    [IO.Directory]::CreateDirectory($script:DataDirectory) | Out-Null
    $probe = Join-Path $script:DataDirectory ".quickstart-write-test-$PID"
    try {
        [IO.File]::WriteAllText($probe, "writable")
    } finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
    }
    $env:NEXUSHARNESS_DATA_DIR = $script:DataDirectory
    $env:NEXUSHARNESS_PORT = [string]$script:EffectivePort
    Write-Success "Persistent data directory: $($script:DataDirectory)"
}

function Get-DependencyFingerprint {
    $identity = & $script:NodeExe -p process.version+process.platform+process.arch
    if ($LASTEXITCODE -ne 0 -or -not $identity) { throw "Dependency fingerprint identity generation failed." }
    $lockBytes = [IO.File]::ReadAllBytes((Join-Path $script:RootDir "package-lock.json"))
    $identityBytes = [Text.Encoding]::UTF8.GetBytes(([string]$identity).Trim())
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        [void]$sha.TransformBlock($lockBytes, 0, $lockBytes.Length, $null, 0)
        [void]$sha.TransformFinalBlock($identityBytes, 0, $identityBytes.Length)
        return ([BitConverter]::ToString($sha.Hash)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-DependencyTree {
    & $script:NpmExe "ls" "--depth=0" *> $null
    return $LASTEXITCODE -eq 0
}

function Remove-GeneratedDependencies {
    $target = [IO.Path]::GetFullPath((Join-Path $script:RootDir "node_modules"))
    $expected = [IO.Path]::GetFullPath((Join-Path $script:RootDir "node_modules"))
    if ($target -ne $expected -or [IO.Directory]::GetParent($target).FullName -ne $script:RootDir) {
        throw "Refusing to remove node_modules outside the repository."
    }
    if (Test-Path -LiteralPath $target) {
        Write-WarningLog "Removing the generated dependency directory before repair."
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

function Install-Dependencies {
    $stateDirectory = Join-Path $script:DataDirectory "bootstrap"
    [IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
    $stamp = Join-Path $stateDirectory "dependencies.sha256"
    $fingerprint = Get-DependencyFingerprint
    $stampMatches = (Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $fingerprint)

    if (-not $Repair -and $stampMatches -and (Test-DependencyTree)) {
        Write-Success "Dependencies match package-lock.json; installation skipped."
        return
    }

    Write-Info "Installing deterministic dependencies with npm ci..."
    $installed = $true
    try {
        Invoke-Native -FilePath $script:NpmExe -ArgumentList @("ci", "--include=dev", "--no-audit", "--no-fund") -Description "npm ci"
    } catch {
        $installed = $false
        Write-WarningLog "Initial npm ci failed: $($_.Exception.Message)"
    }
    if (-not $installed) {
        Write-WarningLog "Verifying the npm cache and rebuilding generated dependencies."
        try {
            Invoke-Native -FilePath $script:NpmExe -ArgumentList @("cache", "verify") -Description "npm cache verify"
        } catch {
            Write-WarningLog "npm cache verification reported a problem; retrying from the registry."
        }
        Remove-GeneratedDependencies
        Invoke-Native -FilePath $script:NpmExe -ArgumentList @("ci", "--include=dev", "--no-audit", "--no-fund") -Description "npm ci repair"
        Write-Success "Dependency tree repaired from package-lock.json."
    } else {
        Write-Success "Dependencies installed."
    }
    [IO.File]::WriteAllText($stamp, "$fingerprint`n")
}

function Build-Application {
    Write-Info "Building server and browser production artifacts..."
    try {
        Invoke-Native -FilePath $script:NpmExe -ArgumentList @("run", "build") -Description "npm run build"
    } catch {
        Write-WarningLog "Build failed. Forcing one dependency refresh before retrying."
        Remove-GeneratedDependencies
        Invoke-Native -FilePath $script:NpmExe -ArgumentList @("ci", "--include=dev", "--no-audit", "--no-fund") -Description "npm ci build repair"
        Invoke-Native -FilePath $script:NpmExe -ArgumentList @("run", "build") -Description "npm run build retry"
    }
    Write-Success "Production build completed."
}

function Update-MemoryDatabase {
    Write-Info "Applying idempotent memory-vector database migrations..."
    Invoke-Native -FilePath $script:NpmExe -ArgumentList @("run", "memory:migrate") -Description "npm run memory:migrate"
    Write-Success "Memory database is current and healthy."
}

function Test-ProductionBuild {
    if ($SkipSmoke -or $Dev) {
        Write-WarningLog "Production smoke test skipped by request or development mode."
        return
    }
    Write-Info "Running isolated production smoke verification..."
    Invoke-Native -FilePath $script:NpmExe -ArgumentList @("run", "test:smoke") -Description "npm run test:smoke"
    Write-Success "Production smoke verification passed."
}

function Get-HealthyServer {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:EffectivePort)/api/health" -TimeoutSec 2 -ErrorAction Stop
        if ($health.status -eq "ok" -and $health.version) { return $health }
    } catch { }
    return $null
}

function Test-PortAvailable {
    param([Parameter(Mandatory)] [int]$PortToTest)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $PortToTest)
    try {
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        try { $listener.Stop() } catch { }
    }
}

function Get-PortOwnerDescription {
    param([Parameter(Mandatory)] [int]$PortToInspect)
    try {
        $connection = Get-NetTCPConnection -LocalPort $PortToInspect -State Listen -ErrorAction Stop | Select-Object -First 1
        $owner = Get-Process -Id $connection.OwningProcess -ErrorAction Stop
        return "$($owner.ProcessName) (PID $($owner.Id))"
    } catch {
        return "another process"
    }
}

function Find-AvailablePort {
    param([Parameter(Mandatory)] [int]$StartingAfter)
    $upperBound = [Math]::Min(65535, $StartingAfter + 100)
    for ($candidate = $StartingAfter + 1; $candidate -le $upperBound; $candidate++) {
        if (Test-PortAvailable -PortToTest $candidate) { return $candidate }
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Resolve-LaunchPort {
    if ($NoStart) { return }
    if (Get-HealthyServer) { return }
    if (Test-PortAvailable -PortToTest $script:EffectivePort) { return }

    $owner = Get-PortOwnerDescription -PortToInspect $script:EffectivePort
    if ($script:PortWasExplicit) {
        throw "Requested port $($script:EffectivePort) is occupied by $owner. Stop that service or choose another port with -Port."
    }
    $previous = $script:EffectivePort
    $script:EffectivePort = Find-AvailablePort -StartingAfter $previous
    $env:NEXUSHARNESS_PORT = [string]$script:EffectivePort
    Write-WarningLog "Default port $previous is occupied by $owner; using available port $($script:EffectivePort) instead."
}

function Wait-NexusHealth {
    param([Diagnostics.Process]$Process)
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "NexusHarness exited before becoming healthy with code $($Process.ExitCode)."
        }
        $health = Get-HealthyServer
        if ($health) { return $health }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for NexusHarness on port $($script:EffectivePort)."
}

function Stop-NexusChild {
    if (-not $script:ChildProcess -or $script:ChildProcess.HasExited) { return }
    Write-WarningLog "Stopping NexusHarness process tree (pid $($script:ChildProcess.Id))..."
    try {
        & taskkill.exe /PID $script:ChildProcess.Id /T /F *> $null
    } catch {
        try { $script:ChildProcess.Kill() } catch { }
    }
    try { $script:ChildProcess.WaitForExit(5000) | Out-Null } catch { }
}

function Start-NexusHarness {
    if ($NoStart) {
        Write-Success "Deployment prepared. Start later with .\quickstart.ps1 or npm start."
        return
    }

    $existing = Get-HealthyServer
    if ($existing) {
        Write-Success "NexusHarness $($existing.version) is already healthy at http://127.0.0.1:$($script:EffectivePort); no duplicate process started."
        return
    }
    Resolve-LaunchPort

    if ($Dev) {
        Write-Info "Starting development mode. UI: http://127.0.0.1:5173  API: http://127.0.0.1:$($script:EffectivePort)"
        Invoke-Native -FilePath $script:NpmExe -ArgumentList @("run", "dev") -Description "npm run dev"
        return
    }

    $env:NODE_ENV = "production"
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $script:NodeExe
    $startInfo.Arguments = "dist-server/server/index.js"
    $startInfo.WorkingDirectory = $script:RootDir
    $startInfo.UseShellExecute = $false
    Write-Info "Starting NexusHarness production server..."
    $script:ChildProcess = [Diagnostics.Process]::Start($startInfo)
    try {
        $health = Wait-NexusHealth -Process $script:ChildProcess
        Write-Success "NexusHarness is ready at http://127.0.0.1:$($script:EffectivePort)"
        Write-Info "Health: version=$($health.version), mode=$($health.mode), memory=$($health.memory.retrievalMode)"
        Write-Info "Press Ctrl+C to stop. Persistent state remains in $($script:DataDirectory)"
        $script:ChildProcess.WaitForExit()
        if ($script:ChildProcess.ExitCode -ne 0) {
            throw "NexusHarness exited with code $($script:ChildProcess.ExitCode)."
        }
    } finally {
        Stop-NexusChild
    }
}

try {
    $script:PortWasExplicit = $PSBoundParameters.ContainsKey("Port") -or [bool]$env:NEXUSHARNESS_PORT
    if (-not $PSBoundParameters.ContainsKey("Port") -and $env:NEXUSHARNESS_PORT) {
        $parsedPort = 0
        if (-not [int]::TryParse($env:NEXUSHARNESS_PORT, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
            throw "NEXUSHARNESS_PORT must be an integer from 1 through 65535."
        }
        $script:EffectivePort = $parsedPort
    } else {
        $script:EffectivePort = $Port
    }
    if (-not $PSBoundParameters.ContainsKey("DataDir") -and $env:NEXUSHARNESS_DATA_DIR) {
        $DataDir = $env:NEXUSHARNESS_DATA_DIR
    }

    Show-Banner
    Write-Info "Bootstrap version $($script:ScriptVersion); mode=$(if ($Dev) { 'development' } else { 'production' }); port=$($script:EffectivePort)"
    Confirm-Repository
    Ensure-Node
    Initialize-DataDirectory
    Resolve-LaunchPort
    Install-Dependencies
    Build-Application
    Update-MemoryDatabase
    Test-ProductionBuild
    Start-NexusHarness
} catch {
    Stop-NexusChild
    Write-Log -Level "FAIL" -Message $_.Exception.Message -Color Red
    Write-Host "Review the failure above; use -Repair only for dependency or build problems. User data was not removed." -ForegroundColor DarkGray
    exit 1
} finally {
    Set-Location -LiteralPath $script:RootDir
}
