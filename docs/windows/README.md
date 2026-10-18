# Enterprise Windows setup

The Windows x64 client is a single native executable. It requires the official
Claude Code `2.1.296` or newer, the public enterprise broker URL, and an unexpired
single-use enrollment code from Enterprise IT.

## Install and enroll

Place `ccgc-enterprise-windows-amd64.exe` at a stable path, for example:

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\CCGC\bin" | Out-Null
Copy-Item .\ccgc-enterprise-windows-amd64.exe "$env:LOCALAPPDATA\CCGC\bin\ccgc-enterprise.exe"
& "$env:LOCALAPPDATA\CCGC\bin\ccgc-enterprise.exe" --help
```

Enroll:

```powershell
& "$env:LOCALAPPDATA\CCGC\bin\ccgc-enterprise.exe" enroll `
  --gateway "https://PUBLIC_BROKER_FQDN" `
  --code "CCGC-ONE-TIME-CODE"
```

The executable opens GitHub device authorization and requires the exact GitHub
identity approved by Enterprise IT. After verification it:

1. Protects the 30-day employee key with Windows DPAPI for the current user.
2. Writes only non-secret binding metadata to the enterprise profile.
3. Configures Claude Code to use the enterprise broker.
4. Installs itself as Claude's `apiKeyHelper`.
5. Acknowledges and consumes the one-time enrollment.

The DPAPI ciphertext is stored under
`%LOCALAPPDATA%\CCGC\credentials`. It cannot be decrypted as another Windows
user. Do not copy that directory to another machine or profile.

## Operate

```powershell
& "$env:LOCALAPPDATA\CCGC\bin\ccgc-enterprise.exe" models
claude
```

Claude invokes `ccgc-enterprise token` automatically to exchange the protected
employee key for a short-lived, bounded admission. Do not move the executable
after enrollment; if it must move, run `ccgc-enterprise configure` from its new
location.

The pilot executable is unsigned unless Enterprise IT provides an Authenticode
certificate. Distribute it through an approved channel and verify the published
SHA-256 checksum. Production distribution should use Authenticode signing or
managed software deployment.
