param(
    [string]$action,
    [long]$value = 0
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {

    $asTask =
        $asTaskGeneric.MakeGenericMethod($ResultType)

    $netTask =
        $asTask.Invoke(
            $null,
            @($WinRtTask)
        )

    $netTask.Wait(-1) | Out-Null

    return $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null

try {

    $manager = Await `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    $session = $manager.GetCurrentSession()

    if ($null -eq $session) {
        exit 0
    }

    switch ($action) {

        "play-pause" {

            Await `
                ($session.TryTogglePlayPauseAsync()) `
                ([bool]) | Out-Null
        }

        "next" {

            Await `
                ($session.TrySkipNextAsync()) `
                ([bool]) | Out-Null
        }

        "prev" {

            Await `
                ($session.TrySkipPreviousAsync()) `
                ([bool]) | Out-Null
        }

        "seek" {

            # value는 초 단위
            $ticks =
                [long]($value * 10000000)

            Await `
                ($session.TryChangePlaybackPositionAsync($ticks)) `
                ([bool]) | Out-Null
        }
    }

}
catch {

    # 미디어 앱이 명령을 지원하지 않아도
    # WCW 자체는 계속 실행되도록 무시
}