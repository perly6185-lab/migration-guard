[CmdletBinding()]
param(
    [string]$ConfigPath = "config/zboss-test.runtime.json"
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
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "Encrypted secret store is missing. Run scripts/probes/Set-ZbossRuntimeSecrets.ps1 first."
}

$secretStore = Get-Content -LiteralPath $secretPath -Raw | ConvertFrom-Json -Depth 20
if ($secretStore.provider -ne "windows-dpapi-current-user") {
    throw "Unsupported secret provider: $($secretStore.provider)"
}

function ConvertTo-PlainText {
    param([string]$CipherText)
    $secure = ConvertTo-SecureString -String $CipherText
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$env:MG_JAVA_BASE_URL = $config.topology.gatewayBaseUrl
$env:MG_LOGIN_BASE_URL = $config.topology.gatewayBaseUrl
$env:MG_JAVA_DIRECT_BASE_URL = $config.topology.directDataServiceBaseUrl
$env:MG_JAVA_SERVICE_HOST = $config.topology.serviceHost
$env:MG_MYSQL_HOST = $config.topology.mysql.host
$env:MG_MYSQL_PORT = [string]$config.topology.mysql.port
$env:MG_MYSQL_DATABASE = $config.topology.mysql.database
$env:MG_JAVA_REDIS_URL = "redis://$($config.topology.redis.host):$($config.topology.redis.port)/$($config.topology.redis.database)"
$env:ZBOSS_PAGE_REDIS_URL = $env:MG_JAVA_REDIS_URL

foreach ($binding in $config.credentialStore.bindings) {
    $cipherText = $secretStore.values.($binding.key)
    if ([string]::IsNullOrWhiteSpace($cipherText)) {
        throw "Encrypted value is missing: $($binding.key)"
    }
    [Environment]::SetEnvironmentVariable(
        $binding.environment,
        (ConvertTo-PlainText $cipherText),
        "Process"
    )
}

$escapedUser = [Uri]::EscapeDataString($env:MG_MYSQL_USERNAME)
$escapedPassword = [Uri]::EscapeDataString($env:MG_MYSQL_PASSWORD)
$databaseUrl = "mysql://${escapedUser}:${escapedPassword}@$($config.topology.mysql.host):$($config.topology.mysql.port)/$($config.topology.mysql.database)"
$env:MG_JAVA_DATABASE_URL = $databaseUrl
$env:ZBOSS_PAGE_MYSQL_URL = $databaseUrl

Remove-Item Env:MG_JAVA_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:MG_ALLOW_QUERY_SELF_HEALING -ErrorAction SilentlyContinue
Remove-Item Env:MG_MYSQL_SNAPSHOT_CONFIRMED -ErrorAction SilentlyContinue

[pscustomobject]@{
    Loaded = $true
    Environment = $config.environment
    Gateway = $config.topology.gatewayBaseUrl
    ServiceHost = $config.topology.serviceHost
    MysqlHost = $config.topology.mysql.host
    RedisHost = $config.topology.redis.host
    LoginCredentialPresent = [bool]($env:MG_LOGIN_USERNAME -and $env:MG_LOGIN_PASSWORD)
    MysqlCredentialPresent = [bool]($env:MG_MYSQL_USERNAME -and $env:MG_MYSQL_PASSWORD)
    AccessTokenPersisted = $false
    MutationApprovalLoaded = $false
}
