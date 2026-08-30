param(
  [switch]$Hold,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

# SetThreadExecutionState is scoped to the calling thread. The scheduled
# launcher imports these functions so no second PowerShell process is needed.
if (-not ("OceanWavePowerState" -as [type])) {
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class OceanWavePowerState {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
}

function Enable-OceanWaveKeepAwake {
  $continuous = [uint32]2147483648
  $systemRequired = [uint32]1
  $result = [OceanWavePowerState]::SetThreadExecutionState([uint32]($continuous -bor $systemRequired))
  if ($result -eq 0) {
    throw "Windows rejected the keep-awake request."
  }
}

function Disable-OceanWaveKeepAwake {
  $continuous = [uint32]2147483648
  [OceanWavePowerState]::SetThreadExecutionState($continuous) | Out-Null
}

if ($SelfTest) {
  Enable-OceanWaveKeepAwake
  Disable-OceanWaveKeepAwake
  exit 0
}

if ($Hold) {
  Enable-OceanWaveKeepAwake
  try {
    while ($true) { Start-Sleep -Seconds 30 }
  } finally {
    Disable-OceanWaveKeepAwake
  }
}
