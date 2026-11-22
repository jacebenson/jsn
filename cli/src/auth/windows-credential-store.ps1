# Static command text: all request data (including secrets) arrives on stdin.
# See site/docs/maintainers/domain-model.md, Windows credential helper, for the policy contract.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'host_check'
function Reply($status, $reason, $value) {
    # Stage is assigned only from literals below; never emit exception/source,
    # compiler diagnostics, paths, request data or environment values.
    $result = @{ status = $status; reason = $reason; value = $value; stage = $stage }
    [Console]::Out.Write(($result | ConvertTo-Json -Compress))
}
try {
    if ($PSVersionTable.PSVersion -lt [Version]'5.1' -or
        ($PSVersionTable.PSEdition -eq 'Core' -and $PSVersionTable.PSVersion.Major -lt 7) -or
        [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        Reply 'error' 'unsupported' $null
        exit 0
    }
    $stage = 'language_mode'
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
        Reply 'error' 'capability' $null
        exit 0
    }
    # Restricted with all scopes Undefined is the stock Windows client default:
    # it permits individual command text, unlike -File. Never modify any scope.
    # Refuse ALL explicitly configured enterprise policy, including RemoteSigned:
    # embedded text cannot establish the original script's zone/signature status.
    foreach ($scope in @('MachinePolicy', 'UserPolicy')) {
        $stage = if ($scope -eq 'MachinePolicy') { 'machine_policy_query' } else { 'user_policy_query' }
        $policy = [string](Microsoft.PowerShell.Security\Get-ExecutionPolicy -Scope $scope -ErrorAction Stop)
        if ($policy -ne 'Undefined') {
            Reply 'error' 'policy' $null
            exit 0
        }
    }
    # Also honor explicit local/session Restricted or AllSigned. Fail closed on
    # unknown policy values. No Set-ExecutionPolicy, environment or registry writes.
    foreach ($scope in @('Process', 'CurrentUser', 'LocalMachine')) {
        $stage = switch ($scope) {
            'Process' { 'process_policy_query' }
            'CurrentUser' { 'current_user_policy_query' }
            'LocalMachine' { 'local_machine_policy_query' }
        }
        $policy = [string](Microsoft.PowerShell.Security\Get-ExecutionPolicy -Scope $scope -ErrorAction Stop)
        if ($policy -notin @('Undefined', 'RemoteSigned', 'Unrestricted', 'Bypass')) {
            Reply 'error' 'policy' $null
            exit 0
        }
    }
    $stage = 'input_encoding'
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $stage = 'output_encoding'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $stage = 'native_compilation'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JsnCredentialNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool NativeRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool Write(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool NativeDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll", EntryPoint="CredFree")]
    public static extern void Free(IntPtr credential);
    public class ReadResult {
        public int Error;
        public string Value;
    }
    public static ReadResult ReadCredential(string target) {
        IntPtr pointer;
        bool success = NativeRead(target, 1, 0, out pointer);
        int error = Marshal.GetLastWin32Error();
        if (!success) return new ReadResult { Error = error };
        try { return new ReadResult { Error = 0, Value = ReadValue(pointer) }; }
        finally { Free(pointer); }
    }
    public static int DeleteCredential(string target) {
        bool success = NativeDelete(target, 1, 0);
        int error = Marshal.GetLastWin32Error();
        return success ? 0 : error;
    }
    private static string ReadValue(IntPtr pointer) {
        Credential c = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
        byte[] bytes = new byte[c.CredentialBlobSize];
        Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
        return new UTF8Encoding(false, true).GetString(bytes);
    }
    public static bool WriteValue(string target, string username, string value) {
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(value);
        if (bytes.Length > 2560) throw new ArgumentException();
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            Credential c = new Credential();
            c.Type = 1; c.TargetName = target; c.UserName = username;
            c.Persist = 2; c.CredentialBlobSize = (uint)bytes.Length; c.CredentialBlob = pointer;
            return Write(ref c, 0);
        } finally {
            for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(pointer, i, 0);
            Marshal.FreeHGlobal(pointer);
            Array.Clear(bytes, 0, bytes.Length);
        }
    }
}
'@
} catch {
    Reply 'error' 'capability' $null
    exit 0
}
try {
    $stage = 'request_decode'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.target -isnot [string] -or !$request.target.StartsWith('servicenow-cli:') -or
        $request.target.Length -gt 32767 -or $request.target.Contains([char]0)) {
        Reply 'error' 'native' $null
        exit 0
    }
    switch ($request.operation) {
        'write' {
            $stage = 'native_write'
            if ($request.value -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($request.value) -gt 2560) {
                Reply 'error' 'oversized' $null
            } elseif ([JsnCredentialNative]::WriteValue($request.target, $request.username, $request.value)) {
                Reply 'ok' $null $null
            } else { Reply 'error' 'native' $null }
        }
        'read' {
            $stage = 'native_read'
            $result = [JsnCredentialNative]::ReadCredential($request.target)
            if ($result.Error -eq 0) { Reply 'ok' $null $result.Value }
            elseif ($result.Error -eq 1168) { Reply 'missing' $null $null }
            else { Reply 'error' 'native' $null }
        }
        'delete' {
            $stage = 'native_delete'
            $errorCode = [JsnCredentialNative]::DeleteCredential($request.target)
            if ($errorCode -eq 0) { Reply 'ok' $null $null }
            elseif ($errorCode -eq 1168) { Reply 'missing' $null $null }
            else { Reply 'error' 'native' $null }
        }
        default { Reply 'error' 'native' $null }
    }
} catch {
    Reply 'error' 'native' $null
}
