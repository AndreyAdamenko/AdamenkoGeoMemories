# Windows PowerShell 5.1 compatible. All paths are relative to the application.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PlainText([Security.SecureString]$Secret) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function New-PrivateRuntimeDirectory {
    $folder = Join-Path $env:LOCALAPPDATA ('AdamenkoGeoMemories\public-runtime\' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $folder -AclObject $acl
    return $folder
}

function Get-PublicResponse([string]$Url, [string]$Method = 'GET', [string]$Authorization = '') {
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Method = $Method
    $request.Timeout = 20000
    $request.AllowAutoRedirect = $false
    $request.Headers.Add('ngrok-skip-browser-warning', 'true')
    if ($Authorization) { $request.Headers.Add('Authorization', $Authorization) }
    if ($Method -eq 'POST') { $request.ContentLength = 0 }
    $response = $null
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
        if ($null -eq $_.Exception.Response) { throw }
        $response = $_.Exception.Response
    }
    try { return [pscustomobject]@{ Status = [int]$response.StatusCode; Challenge = $response.Headers['WWW-Authenticate'] } }
    finally { $response.Close() }
}

function Start-PublicGallery {
    param([Security.SecureString]$Password, [switch]$VerifyOnly)
    $appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $node = Join-Path $appRoot 'node_modules\node\bin\node.exe'
    $toolDir = Join-Path $appRoot 'tools\ngrok'
    $ngrok = Join-Path $toolDir 'ngrok.exe'
    $tokenFile = Join-Path $toolDir 'authtoken.dpapi'
    $utf8 = [Text.UTF8Encoding]::new($false)
    $runtime = $null
    $serverProcess = $null
    $tunnelProcess = $null
    $mutex = $null
    $ownsMutex = $false
    $plainPassword = $null
    $plainToken = $null
    $authorization = $null
    try {
        if (-not (Test-Path -LiteralPath $node)) { throw 'Local Node.js is missing. Copy the complete portable application.' }
        if (-not (Test-Path -LiteralPath $ngrok)) { throw 'ngrok.exe is missing from tools\ngrok. Download it from https://ngrok.com/download/windows.' }
        $mutex = New-Object Threading.Mutex($false, 'Local\AdamenkoGeoMemories-PublicLauncher')
        try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { throw 'The public launcher is already running. Close its window first.' }

        Write-Host 'AdamenkoGeoMemories: password-protected, read-only public gallery'
        Write-Host 'Public username: viewer'
        do {
            if ($null -eq $Password) { $Password = Read-Host 'Set public password (8-128 ASCII characters)' -AsSecureString }
            $plainPassword = Get-PlainText $Password
            $valid = $plainPassword.Length -ge 8 -and $plainPassword.Length -le 128 -and $plainPassword -cmatch '^[\x20-\x7E]+$' -and -not $plainPassword.Contains('${')
            if (-not $valid) {
                if ($VerifyOnly) { throw 'Invalid test password.' }
                Write-Host 'Use 8-128 Latin letters, digits or symbols; the sequence ${ is reserved by ngrok.'
                $Password = $null
            }
        } until ($valid)

        $token = $null
        if ($env:NGROK_AUTHTOKEN) { $token = ConvertTo-SecureString $env:NGROK_AUTHTOKEN -AsPlainText -Force }
        elseif (Test-Path -LiteralPath $tokenFile) {
            try { $token = ConvertTo-SecureString ([IO.File]::ReadAllText($tokenFile)) }
            catch { Write-Host 'Saved ngrok token belongs to another Windows account. Enter it again.' }
        }
        if ($null -eq $token) {
            $token = Read-Host 'ngrok authtoken (hidden; saved encrypted for this Windows account)' -AsSecureString
            if ($token.Length -eq 0) { throw 'ngrok authtoken is required.' }
            [IO.File]::WriteAllText($tokenFile, (ConvertFrom-SecureString $token), $utf8)
        }
        $plainToken = Get-PlainText $token
        $runtime = New-PrivateRuntimeDirectory

        Push-Location -LiteralPath $appRoot
        try { $configJson = & $node --input-type=module --eval 'import {loadConfig} from "./server/config.ts"; console.log(JSON.stringify(loadConfig()));' }
        finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read application settings.' }
        $config = $configJson | ConvertFrom-Json
        $port = [int]$config.port
        $localUrl = 'http://127.0.0.1:' + $port
        $status = $null
        try { $status = Invoke-RestMethod ($localUrl + '/api/status') -TimeoutSec 2 } catch {}
        if ($null -eq $status) {
            $serverProcess = Start-Process -FilePath $node -ArgumentList @(('"' + (Join-Path $appRoot 'server\index.ts') + '"')) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'server.log') -RedirectStandardError (Join-Path $runtime 'server-error.log') -PassThru
            for ($attempt = 0; $attempt -lt 40; $attempt++) {
                if ($serverProcess.HasExited) { throw 'Photo server could not start. Check that its port is free.' }
                try { $status = Invoke-RestMethod ($localUrl + '/api/status') -TimeoutSec 2; break } catch {}
                Start-Sleep -Milliseconds 500
            }
        } else { Write-Host 'Using the already running local server; it will remain running after exit.' }
        if ($null -eq $status -or [IO.Path]::GetFullPath($status.dataDir) -ne [IO.Path]::GetFullPath($config.dataDir)) { throw 'The port is occupied by another catalog or the server is not ready.' }

        # Replace only tunnels launched from this portable application's ngrok.exe.
        Get-Process -Name ngrok -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ngrok } | Stop-Process

        $policy = @{ on_http_request = @(
            @{ actions = @(@{ type = 'basic-auth'; config = @{ credentials = @('viewer:' + $plainPassword); realm = 'AdamenkoGeoMemories'; enforce = $true } }) },
            @{ expressions = @("req.method != 'GET' && req.method != 'HEAD'"); actions = @(@{ type = 'custom-response'; config = @{ status_code = 403; content = 'Shared photo gallery is read-only.'; headers = @{ 'content-type' = 'text/plain; charset=utf-8' } } }) },
            @{ actions = @(@{ type = 'add-headers'; config = @{ headers = @{ host = ('127.0.0.1:' + $port) } } }) }
        ) }
        $policyFile = Join-Path $runtime 'policy.json'
        [IO.File]::WriteAllText($policyFile, ($policy | ConvertTo-Json -Depth 15), $utf8)
        $oldToken = $env:NGROK_AUTHTOKEN
        try {
            $env:NGROK_AUTHTOKEN = $plainToken
            $tunnelProcess = Start-Process -FilePath $ngrok -ArgumentList @('http', $localUrl, '--inspect=false', '--traffic-policy-file', ('"' + $policyFile + '"'), '--log=stdout', '--log-format=json') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'ngrok.log') -RedirectStandardError (Join-Path $runtime 'ngrok-error.log') -PassThru
        } finally { $env:NGROK_AUTHTOKEN = $oldToken; $plainToken = $null }
        $publicUrl = $null
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if ($tunnelProcess.HasExited) {
                $logs = [IO.File]::ReadAllText((Join-Path $runtime 'ngrok.log')) + [IO.File]::ReadAllText((Join-Path $runtime 'ngrok-error.log'))
                $errorCode = [regex]::Match($logs, 'ERR_NGROK_\d+').Value
                throw ('ngrok could not start. ' + $errorCode + ' Check your token and internet connection.')
            }
            try {
                $tunnels = Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
                $match = @($tunnels.tunnels | Where-Object { $_.config.addr -eq $localUrl -and $_.public_url.StartsWith('https://') })
                if ($match.Count -gt 0) { $publicUrl = $match[0].public_url; break }
            } catch {}
            Start-Sleep -Milliseconds 500
        }
        if (-not $publicUrl) { throw 'Timed out waiting for the public URL. Close other ngrok agents and try again.' }
        $authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('viewer:' + $plainPassword))
        $anonymous = Get-PublicResponse ($publicUrl + '/api/status')
        $wrongPassword = Get-PublicResponse ($publicUrl + '/api/status') 'GET' ('Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('viewer:' + [Guid]::NewGuid().ToString('N'))))
        $allowed = Get-PublicResponse ($publicUrl + '/') 'GET' $authorization
        $photos = Get-PublicResponse ($publicUrl + '/api/photos?limit=1') 'GET' $authorization
        $map = Get-PublicResponse ($publicUrl + '/api/map?bbox=-180,-85,180,85&zoom=1') 'GET' $authorization
        $blocked = Get-PublicResponse ($publicUrl + '/api/photos/edit') 'POST' $authorization
        if ($anonymous.Status -ne 401 -or -not $anonymous.Challenge -or $wrongPassword.Status -ne 401 -or $allowed.Status -ne 200 -or $photos.Status -ne 200 -or $map.Status -ne 200 -or $blocked.Status -ne 403) { throw 'Public authentication/read-only verification failed. Tunnel closed.' }
        # ngrok has loaded the policy; remove the temporary plaintext credentials.
        Remove-Item -LiteralPath $policyFile -Force
        $plainPassword = $null
        $authorization = $null
        $policy = $null
        Write-Host ''
        Write-Host ('PUBLIC URL: ' + $publicUrl) -ForegroundColor Green
        Write-Host 'Login: viewer | Password: the one you entered at startup'
        Write-Host 'Verified: password required, viewing allowed, editing blocked.'
        Write-Host ('Local access (editing allowed): ' + $localUrl)
        if ($VerifyOnly) { return $publicUrl }
        Write-Host 'Keep this window open. Press Enter to stop public sharing.'
        $null = Read-Host
    } finally {
        if ($null -ne $tunnelProcess -and -not $tunnelProcess.HasExited) { Stop-Process -Id $tunnelProcess.Id -ErrorAction SilentlyContinue }
        if ($null -ne $serverProcess -and -not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue }
        $plainPassword = $null
        $plainToken = $null
        $authorization = $null
        if ($runtime -and (Test-Path -LiteralPath $runtime)) {
            # Only known files in this invocation's private temporary directory.
            foreach ($file in @('policy.json', 'server.log', 'server-error.log', 'ngrok.log', 'ngrok-error.log')) {
                Remove-Item -LiteralPath (Join-Path $runtime $file) -Force -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $runtime -ErrorAction SilentlyContinue
        }
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        if ($null -ne $mutex) { $mutex.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Start-PublicGallery }
    catch { Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
}
