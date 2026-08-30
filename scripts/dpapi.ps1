param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("protect", "unprotect")]
  [string]$Operation
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()

if ($Operation -eq "protect") {
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($inputText)
  $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
    $plainBytes,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
  exit 0
}

$cipherBytes = [Convert]::FromBase64String($inputText.Trim())
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipherBytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
