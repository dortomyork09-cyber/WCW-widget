[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
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
        Write-Output '{"status":"none"}'
        exit 0
    }

    $info = Await `
        ($session.TryGetMediaPropertiesAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])

    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()

    $title = if ($info.Title) {
        [string]$info.Title
    } else {
        "재생 없음"
    }

    $artist = if ($info.Artist) {
        [string]$info.Artist
    } else {
        "음악을 틀어보세요"
    }

    $status = $playback.PlaybackStatus.ToString()

    $pos = 0
    $dur = 0

    if ($timeline) {

        if ($timeline.Position.TotalSeconds -gt 0) {
            $pos = [long]$timeline.Position.TotalSeconds
        }

        if ($timeline.EndTime.TotalSeconds -gt 0) {
            $dur = [long]$timeline.EndTime.TotalSeconds
        }
    }

    # WCW 폴더
    $wcwDir = "C:\WCW"

    if (-not (Test-Path $wcwDir)) {
        New-Item `
            -ItemType Directory `
            -Path $wcwDir `
            -Force | Out-Null
    }

    $thumbPath = Join-Path $wcwDir "thumb.jpg"

    $hasThumbnail = $false

    # 앨범아트 가져오기
    try {

        $thumb = $info.Thumbnail

        if ($null -ne $thumb) {

            $stream = Await `
                ($thumb.OpenReadAsync()) `
                ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])

            if ($null -ne $stream) {

                $size = [uint32]$stream.Size

                if ($size -gt 0) {

                    $buffer = New-Object byte[] $size

                    $dataReader =
                        [Windows.Storage.Streams.DataReader]::new($stream)

                    $loadOp = $dataReader.LoadAsync($size)

                    Await `
                        $loadOp `
                        ([uint32]) | Out-Null

                    $dataReader.ReadBytes($buffer)

                    [System.IO.File]::WriteAllBytes(
                        $thumbPath,
                        $buffer
                    )

                    $hasThumbnail = $true

                    $dataReader.Dispose()
                    $stream.Dispose()
                }
            }
        }

    } catch {

        $hasThumbnail = $false
    }

    $result = [PSCustomObject]@{
        status       = $status
        title        = $title
        artist       = $artist
        position     = $pos
        duration     = $dur
        hasThumbnail = $hasThumbnail
        thumbPath    = $thumbPath
    }

    $result | ConvertTo-Json -Compress

}
catch {

    Write-Output '{"status":"none"}'
}