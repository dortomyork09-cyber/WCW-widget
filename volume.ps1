param(
    [int]$level = -1
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 이미 Audio 클래스가 등록되어 있으면 다시 등록하지 않음
if (-not ("WCW.Audio" -as [type])) {

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace WCW
{
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        int f();
        int g();
        int h();
        int i();

        int SetMasterVolumeLevelScalar(
            float fLevel,
            Guid pguidEventContext
        );

        int j();

        int GetMasterVolumeLevelScalar(
            out float pfLevel
        );

        int k();
        int l();
        int m();
        int n();

        int SetMute(
            [MarshalAs(UnmanagedType.Bool)] bool bMute,
            Guid pguidEventContext
        );

        int GetMute(
            out bool pbMute
        );
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(
            ref Guid id,
            int clsCtx,
            int activationParams,
            out IAudioEndpointVolume aev
        );
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int f();

        int GetDefaultAudioEndpoint(
            int dataFlow,
            int role,
            out IMMDevice endpoint
        );
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject
    {
    }

    public static class Audio
    {
        static IAudioEndpointVolume GetVolume()
        {
            var enumerator =
                new MMDeviceEnumeratorComObject()
                as IMMDeviceEnumerator;

            IMMDevice device = null;

            Marshal.ThrowExceptionForHR(
                enumerator.GetDefaultAudioEndpoint(
                    0,
                    1,
                    out device
                )
            );

            IAudioEndpointVolume volume = null;

            Guid iid =
                typeof(IAudioEndpointVolume).GUID;

            Marshal.ThrowExceptionForHR(
                device.Activate(
                    ref iid,
                    23,
                    0,
                    out volume
                )
            );

            return volume;
        }

        public static float Volume
        {
            get
            {
                float value = 0;

                Marshal.ThrowExceptionForHR(
                    GetVolume()
                        .GetMasterVolumeLevelScalar(
                            out value
                        )
                );

                return value;
            }

            set
            {
                float safe =
                    Math.Max(
                        0,
                        Math.Min(
                            1,
                            value
                        )
                    );

                Marshal.ThrowExceptionForHR(
                    GetVolume()
                        .SetMasterVolumeLevelScalar(
                            safe,
                            Guid.Empty
                        )
                );
            }
        }
    }
}
'@

}

try {

    # level을 전달하면 볼륨 변경
    if ($level -ge 0) {

        # 0~100으로 강제
        $safeLevel =
            [Math]::Max(
                0,
                [Math]::Min(
                    100,
                    $level
                )
            )

        [WCW.Audio]::Volume =
            $safeLevel / 100.0

        Write-Output $safeLevel
    }

    # level을 안 주면 현재 볼륨 반환
    else {

        $current =
            [WCW.Audio]::Volume * 100

        Write-Output (
            [Math]::Round(
                $current
            )
        )
    }

}
catch {

    Write-Output "0"
}