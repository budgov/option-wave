[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$ConfigPath = "config.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-NativeSupervisorSelfTest {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Config
  )

  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Executable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WorkingDirectory = $Root
  $arguments = @("--project-root", $Root, "--config", $Config, "--self-test")
  if ($start.PSObject.Properties.Name -contains "ArgumentList") {
    foreach ($argument in $arguments) { [void]$start.ArgumentList.Add($argument) }
  } else {
    # Windows paths cannot contain a quote. Canonical project/config paths do
    # not retain a trailing separator, so standard quoting is sufficient here.
    $start.Arguments = ($arguments | ForEach-Object {
      if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ }
    }) -join ' '
  }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw "Could not start native supervisor self-test." }
    $process.WaitForExit()
    return $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$source = Join-Path $root "native\ocean_wave_supervisor.cpp"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Missing native supervisor source: $source"
}

$config = if ([System.IO.Path]::IsPathRooted($ConfigPath)) {
  (Resolve-Path -LiteralPath $ConfigPath).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $root $ConfigPath)).Path
}
if ((Split-Path -Parent $config) -ine $root) {
  throw "The supervisor config must be directly inside the project root."
}

$vswhereCandidates = @()
if (${env:ProgramFiles(x86)}) {
  $vswhereCandidates += Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
}
if ($env:ProgramFiles) {
  $vswhereCandidates += Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe"
}
$vswhere = $vswhereCandidates | Where-Object {
  Test-Path -LiteralPath $_ -PathType Leaf
} | Select-Object -First 1
if (-not $vswhere) {
  throw "Visual Studio Build Tools discovery utility (vswhere.exe) was not found."
}

$installation = (& $vswhere -latest -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($installation)) {
  throw "Visual Studio C++ x64 Build Tools are not installed."
}
$vcvars = Join-Path $installation "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
  throw "Missing x64 compiler environment: $vcvars"
}

# Import only the compiler environment produced by Microsoft's installed setup
# script. Compilation itself invokes cl.exe directly; this generated executable
# never uses cmd.exe or PowerShell at runtime.
$environmentCommand = '"' + $vcvars + '" >nul && set'
$environmentLines = & $env:ComSpec /d /s /c $environmentCommand
if ($LASTEXITCODE -ne 0) {
  throw "vcvars64.bat failed with exit code $LASTEXITCODE."
}
foreach ($line in $environmentLines) {
  $separator = $line.IndexOf('=')
  if ($separator -le 0) { continue }
  $name = $line.Substring(0, $separator)
  $value = $line.Substring($separator + 1)
  [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

$compiler = (Get-Command cl.exe -CommandType Application -ErrorAction Stop).Source
$buildId = [Guid]::NewGuid().ToString("N")
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "OceanWaveSupervisorBuild-$buildId"
$temporaryExecutable = Join-Path $temporaryDirectory "OceanWaveSupervisor.exe"
$temporaryObject = Join-Path $temporaryDirectory "ocean_wave_supervisor.obj"
$bin = Join-Path $root "bin"
$target = Join-Path $bin "OceanWaveSupervisor.exe"
$sidecar = "$target.sha256"
$candidate = Join-Path $bin "OceanWaveSupervisor.exe.new-$buildId"
$candidateSidecar = "$candidate.sha256"
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $temporaryDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $bin | Out-Null

try {
  $compilerArguments = @(
    "/nologo",
    "/std:c++17",
    "/O2",
    "/GL",
    "/Gy",
    "/MT",
    "/EHsc",
    "/W4",
    "/WX",
    "/GS",
    "/sdl",
    "/guard:cf",
    "/permissive-",
    "/utf-8",
    "/Zc:__cplusplus",
    "/Zc:wchar_t",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_WIN32_WINNT=0x0A00",
    "/pathmap:$root=.",
    "/Fo$temporaryObject",
    "/Fe$temporaryExecutable",
    $source,
    "/link",
    "/SUBSYSTEM:WINDOWS",
    "/LTCG",
    "/OPT:REF",
    "/OPT:ICF",
    "/DYNAMICBASE",
    "/HIGHENTROPYVA",
    "/NXCOMPAT",
    "/GUARD:CF",
    "/Brepro",
    "/MANIFEST:EMBED",
    "/MANIFESTUAC:level='asInvoker' uiAccess='false'",
    "shell32.lib",
    "user32.lib"
  )
  $compilerOutput = & $compiler @compilerArguments 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryExecutable -PathType Leaf)) {
    $details = ($compilerOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    throw "Native supervisor compilation failed with exit code $LASTEXITCODE.`n$details"
  }

  $temporarySelfTest = Invoke-NativeSupervisorSelfTest `
    -Executable $temporaryExecutable -Root $root -Config $config
  if ($temporarySelfTest -ne 0) {
    throw "Native supervisor self-test failed with exit code $temporarySelfTest."
  }

  Copy-Item -LiteralPath $temporaryExecutable -Destination $candidate -Force
  $candidateHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($candidateHash -notmatch '^[0-9a-f]{64}$') {
    throw "Compiler output did not produce a valid SHA-256 digest."
  }
  [System.IO.File]::WriteAllText($candidateSidecar, "$candidateHash`n", $utf8WithoutBom)

  # Both candidates are complete before publication. The same-volume rename of
  # the executable prevents readers from observing a partially copied binary;
  # the installer also fails closed unless the sidecar matches exactly.
  Move-Item -LiteralPath $candidate -Destination $target -Force
  Move-Item -LiteralPath $candidateSidecar -Destination $sidecar -Force

  $publishedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  $recordedHash = (Get-Content -LiteralPath $sidecar -Raw).Trim().ToLowerInvariant()
  if ($recordedHash -notmatch '^[0-9a-f]{64}$' -or $recordedHash -ne $publishedHash) {
    throw "Published supervisor SHA-256 sidecar does not match the executable."
  }

  $publishedSelfTest = Invoke-NativeSupervisorSelfTest `
    -Executable $target -Root $root -Config $config
  if ($publishedSelfTest -ne 0) {
    throw "Published native supervisor self-test failed with exit code $publishedSelfTest."
  }

  [PSCustomObject]@{
    executable = $target
    sha256 = $publishedHash
    sidecar = $sidecar
    compiler = $compiler
    self_test = "passed"
  }
} finally {
  if (Test-Path -LiteralPath $candidate) {
    Remove-Item -LiteralPath $candidate -Force
  }
  if (Test-Path -LiteralPath $candidateSidecar) {
    Remove-Item -LiteralPath $candidateSidecar -Force
  }
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
