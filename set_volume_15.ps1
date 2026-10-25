# Pone el volumen maestro de la PC al 15%
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
        vol.SetMute(false, Guid.Empty);
        vol.SetMasterVolumeLevelScalar(level, Guid.Empty);
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
}
"@

[Audio]::SetVolume(0.15)
$actual = [Audio]::GetVolume()
Write-Host ("Volumen actual: {0:P0}" -f $actual)