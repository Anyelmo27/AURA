# Ajusta el volumen maestro de la PC. Uso: .\set_volume.ps1 -Nivel 15   (0-100)
# Opcional: -Mute $true/$false
param(
    [int]$Nivel = -1,
    [Nullable[bool]]$Mute = $null,
    [string]$Accion = "",
    [int]$Veces = 1
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j(); int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }
public class Audio {
    public static void SetVolume(float level) {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        IAudioEndpointVolume vol = null;
        var id = typeof(IAudioEndpointVolume).GUID;
        dev.Activate(ref id, 23, 0, out vol);
        if (level >= 0) vol.SetMasterVolumeLevelScalar(level, Guid.Empty);
    }
    public static void SetMute(bool m) {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        IAudioEndpointVolume vol = null;
        var id = typeof(IAudioEndpointVolume).GUID;
        dev.Activate(ref id, 23, 0, out vol);
        vol.SetMute(m, Guid.Empty);
    }
    public static float GetVolume() {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        IAudioEndpointVolume vol = null;
        var id = typeof(IAudioEndpointVolume).GUID;
        dev.Activate(ref id, 23, 0, out vol);
        float v = 0;
        vol.GetMasterVolumeLevelScalar(out v);
        return v;
    }
    public static bool GetMute() {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        IAudioEndpointVolume vol = null;
        var id = typeof(IAudioEndpointVolume).GUID;
        dev.Activate(ref id, 23, 0, out vol);
        bool m = false;
        vol.GetMute(out m);
        return m;
    }
}
"@

# Resolver accion (subir/bajar/mute) a nivel o mute
if ($Accion -ne "") {
    $a = $Accion.ToLower()
    if ($a -eq "mute") {
        $cur = [Audio]::GetMute()
        [Audio]::SetMute(-not $cur)
    } elseif ($a -eq "subir" -or $a -eq "bajar") {
        $cur = [Audio]::GetVolume() * 100.0
        $step = 5 * [Math]::Max(1, $Veces)
        if ($a -eq "subir") { $Nivel = [Math]::Min(100, $cur + $step) } else { $Nivel = [Math]::Max(0, $cur - $step) }
    }
}

if ($Mute -ne $null) { [Audio]::SetMute($Mute) }
if ($Nivel -ge 0) { $lvl = [Math]::Max(0, [Math]::Min(100, $Nivel)) / 100.0; [Audio]::SetVolume($lvl) }

$v = [Audio]::GetVolume()
$m = [Audio]::GetMute()
Write-Output ("OK volumen={0} mute={1}" -f ([Math]::Round($v*100)), $m)