[CmdletBinding()]
param(
    [string]$ConfigPath = "config/zboss-test.runtime.json",
    [switch]$FromEnvironment
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$resolvedConfig = (Resolve-Path -LiteralPath (Join-Path $repositoryRoot $ConfigPath)).Path
$config = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json -Depth 20
$secretPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $config.credentialStore.path))
$secretRelativePath = [IO.Path]::GetRelativePath($repositoryRoot, $secretPath)
if (
    [IO.Path]::IsPathRooted($secretRelativePath) -or
    $secretRelativePath -eq ".." -or
    $secretRelativePath.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")
) {
    throw "Secret store must stay inside the repository workspace."
}

function Read-SecretValue {
    param(
        [string]$Prompt,
        [string]$EnvironmentName,
        [switch]$PlainInput
    )
    if ($FromEnvironment) {
        $value = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "$EnvironmentName is required when -FromEnvironment is used."
        }
        return ConvertTo-SecureString -String $value -AsPlainText -Force
    }
    if ($PlainInput) {
        $value = Read-Host $Prompt
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "$Prompt cannot be empty."
        }
        return ConvertTo-SecureString -String $value -AsPlainText -Force
    }
    return Read-Host $Prompt -AsSecureString
}

$values = [ordered]@{
    javaTenantId = Read-SecretValue "Java tenant ID" "MG_JAVA_TENANT_ID" -PlainInput
    loginUsername = Read-SecretValue "Application login username" "MG_LOGIN_USERNAME" -PlainInput
    loginPassword = Read-SecretValue "Application login password" "MG_LOGIN_PASSWORD"
    mysqlUsername = Read-SecretValue "MySQL username" "MG_MYSQL_USERNAME" -PlainInput
    mysqlPassword = Read-SecretValue "MySQL password" "MG_MYSQL_PASSWORD"
}

$encrypted = [ordered]@{
    schemaVersion = 1
    provider = "windows-dpapi-current-user"
    environment = $config.environment
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    values = [ordered]@{}
}
foreach ($entry in $values.GetEnumerator()) {
    $encrypted.values[$entry.Key] = ConvertFrom-SecureString -SecureString $entry.Value
}

$secretDirectory = Split-Path -Parent $secretPath
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
$encrypted | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $secretPath -Encoding utf8

[pscustomobject]@{
    Saved = $true
    Provider = $encrypted.provider
    Environment = $encrypted.environment
    SecretCount = $encrypted.values.Count
    AccessTokenPersisted = $false
    MutationApprovalPersisted = $false
}
