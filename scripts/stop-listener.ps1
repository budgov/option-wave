param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(1, 3600)]
  [int]$TimeoutSeconds = 3600
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
Set-Location -LiteralPath $resolvedRoot

& $node "src/cli.js" "stop" "--timeout-seconds" $TimeoutSeconds
if ($LASTEXITCODE -ne 0) {
  throw "Ocean Wave safe stop failed with exit code $LASTEXITCODE. No runtime was forcibly terminated."
}
