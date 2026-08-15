const { app, BrowserWindow, screen, ipcMain, Tray, Menu } = require('electron')
const { exec } = require('child_process')
const path = require('path')
const https = require('https')
const { pathToFileURL } = require('url')

let win = null
let tray = null

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,

    frame: false,
    transparent: true,
    alwaysOnTop: false,

    skipTaskbar: false,
    resizable: false,

    icon: path.join(__dirname, 'icon.png'),

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile('index.html')

  win.setIgnoreMouseEvents(true, {
    forward: true
  })

  ipcMain.on('set-ignore-mouse', (e, ignore) => {
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, {
        forward: true
      })
    }
  })

  const ctrlPath = path.join(__dirname, 'control.ps1')
  const mediaPath = path.join(__dirname, 'media.ps1')

  // ==========================================
  // PowerShell 실행
  // ==========================================

  function runPowerShell(file, args = [], callback = () => {}) {
    const safeArgs = Array.isArray(args) ? args : []

    const argText = safeArgs
      .map(value => {
        const text = String(value ?? '')
        return `"${text.replace(/"/g, '\\"')}"`
      })
      .join(' ')

    const command = [
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      `"${file}"`,
      argText
    ]
      .filter(Boolean)
      .join(' ')

    exec(
      command,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024
      },
      callback
    )
  }

  // ==========================================
  // 음악 제어
  // ==========================================

  ipcMain.on('media-control', (e, action, value) => {
    const val = value !== undefined
      ? Number(value) || 0
      : 0

    runPowerShell(
      ctrlPath,
      [
        '-action',
        String(action || ''),
        '-value',
        val
      ],
      (err, stdout, stderr) => {
        if (err) {
          console.log(
            '[WCW MEDIA CONTROL ERROR]',
            err.message
          )
        }

        if (stderr && stderr.trim()) {
          console.log(
            '[WCW MEDIA CONTROL]',
            stderr.trim()
          )
        }
      }
    )
  })

  // ==========================================
  // 현재 재생 중인 음악
  // ==========================================

  let mediaBusy = false

  function updateMedia() {
    if (mediaBusy) return

    if (!win || win.isDestroyed()) {
      return
    }

    mediaBusy = true

    runPowerShell(
      mediaPath,
      [
        '-outDir',
        app.getPath('userData')
      ],
      (err, stdout, stderr) => {
        mediaBusy = false

        if (!win || win.isDestroyed()) {
          return
        }

        if (err) {
          console.log(
            '[WCW MEDIA ERROR]',
            err.message
          )

          return
        }

        const raw =
          String(stdout || '').trim()

        if (!raw) {
          return
        }

        const lines =
          raw
            .split(/\r?\n/)
            .map(v => v.trim())
            .filter(Boolean)

        let data = null

        // JSON이 여러 줄 출력되어도
        // 마지막 정상 JSON을 찾음
        for (
          let i = lines.length - 1;
          i >= 0;
          i--
        ) {
          try {
            const parsed =
              JSON.parse(lines[i])

            if (
              parsed &&
              typeof parsed === 'object'
            ) {
              data = parsed
              break
            }
          } catch (_) {}
        }

        if (!data) {
          console.log(
            '[WCW MEDIA JSON ERROR]',
            raw.slice(0, 500)
          )

          return
        }

        // 기본값
        data.status =
          data.status || 'none'

        data.title =
          data.title || ''

        data.artist =
          data.artist || ''

        data.position =
          Number(data.position) || 0

        data.duration =
          Number(data.duration) || 0

        data.hasThumbnail =
          Boolean(data.hasThumbnail)

        // media.ps1이 돌려주는 thumbPath는 "C:\Users\...\thumb.jpg" 같은
        // 일반 OS 경로라서, 렌더러의 <img src>에 그대로 넣으면 유효한 URL이
        // 아니라서 로드가 안 된다(항상 file:// URI로 바꿔줘야 브라우저가 읽는다).
        const rawThumbPath =
          data.thumbPath ||
          path.join(app.getPath('userData'), 'thumb.jpg')

        try {
          data.thumbPath = pathToFileURL(rawThumbPath).href
        } catch (_) {
          data.hasThumbnail = false
          data.thumbPath = ''
        }

        // index.html로 전달
        win.webContents.send(
          'media-update',
          data
        )
      }
    )
  }

  // 프로그램 시작
  setTimeout(
    updateMedia,
    1000
  )

  // 음악 상태 1초마다 갱신
  setInterval(
    updateMedia,
    1000
  )

  // ==========================================
  // 뉴스 RSS
  // ==========================================

  ipcMain.handle(
    'fetch-news',
    async () => {
      return new Promise(resolve => {
        https.get(
          'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko',
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0'
            }
          },
          res => {
            let data = ''

            res.on(
              'data',
              chunk => {
                data += chunk
              }
            )

            res.on(
              'end',
              () => {
                resolve(data)
              }
            )
          }
        )
        .on(
          'error',
          () => {
            resolve(null)
          }
        )
      })
    }
  )

  // ==========================================
  // 범용 URL Fetch
  // ==========================================

  ipcMain.handle(
    'fetch-url',
    async (event, url) => {

      function get(u, depth) {
        return new Promise(resolve => {

          if (depth > 5) {
            resolve(null)
            return
          }

          // 네이버·Daum 스포츠 비공식 API는 자기 사이트에서 온 요청처럼
          // Referer가 있어야 정상 응답하는(또는 빈 값을 주지 않는) 경우가 있어
          // 도메인별로 Referer/Origin을 추가해준다. 특히 Daum의 /prx/ 경로는
          // robots.txt에도 크롤러 접근이 막혀있을 만큼 외부 접근에 민감한 경로라
          // Referer 없이는 빈 응답만 오는 것으로 보인다.
          const extraHeaders = {}
          try {
            const host = new URL(u).hostname
            if (/(^|\.)sports\.naver\.com$/i.test(host)) {
              extraHeaders['Referer'] = 'https://m.sports.naver.com/'
              extraHeaders['Origin'] = 'https://m.sports.naver.com'
            } else if (/(^|\.)sports\.daum\.net$/i.test(host)) {
              extraHeaders['Referer'] = 'https://sports.daum.net/schedule/kbo'
              extraHeaders['Origin'] = 'https://sports.daum.net'
              extraHeaders['X-Requested-With'] = 'XMLHttpRequest'
            }
          } catch (e) {}

          const req =
            https.get(
              u,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',

                  'Accept':
                    'application/json, text/plain, */*',

                  'Accept-Language':
                    'ko-KR,ko;q=0.9,en;q=0.8',

                  ...extraHeaders
                }
              },
              res => {

                // 리다이렉트
                if (
                  res.statusCode >= 300 &&
                  res.statusCode < 400 &&
                  res.headers.location
                ) {

                  res.resume()

                  const next =
                    res.headers.location
                      .startsWith('http')
                      ? res.headers.location
                      : new URL(
                          res.headers.location,
                          u
                        ).href

                  resolve(
                    get(
                      next,
                      depth + 1
                    )
                  )

                  return
                }

                if (
                  res.statusCode !== 200
                ) {
                  res.resume()
                  resolve(null)
                  return
                }

                let data = ''

                res.setEncoding('utf8')

                res.on(
                  'data',
                  chunk => {
                    data += chunk
                  }
                )

                res.on(
                  'end',
                  () => {
                    resolve(data)
                  }
                )
              }
            )

          req.on(
            'error',
            () => {
              resolve(null)
            }
          )

          req.setTimeout(
            10000,
            () => {
              req.destroy()
              resolve(null)
            }
          )
        })
      }

      return get(url, 0)
    }
  )

  // ==========================================
  // 야후 파이낸스 전용 요청 (쿠키 + crumb)
  // ==========================================
  // 최근 야후 파이낸스 비공식 API(v8/finance/chart, v1/finance/search)는
  // 쿠키와 crumb(보안 토큰) 없이 반복 요청하면 401(Unauthorized)을 자주 돌려준다.
  // 그래서 별도로 쿠키/crumb를 발급받아 재사용하고, 401을 만나면 새로 발급받아
  // 한 번 더 시도한다. 이걸 안 하면 "주식이 뜨다 안 뜨다" 하는 현상이 생긴다.

  let yahooCookie = null
  let yahooCrumb = null
  let yahooCrumbPromise = null

  function httpsRequest(url, extraHeaders) {
    return new Promise(resolve => {
      let req
      try {
        req = https.get(
          url,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Accept': 'application/json, text/plain, */*',
              ...extraHeaders
            }
          },
          res => {
            let data = ''
            res.setEncoding('utf8')
            res.on('data', c => { data += c })
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: data
              })
            })
          }
        )
      } catch (e) {
        resolve(null)
        return
      }

      req.on('error', () => resolve(null))
      req.setTimeout(10000, () => {
        req.destroy()
        resolve(null)
      })
    })
  }

  function pickCookie(res) {
    const raw = res && res.headers && res.headers['set-cookie']
    if (!raw || !raw.length) return ''
    return raw.map(c => c.split(';')[0]).join('; ')
  }

  async function issueYahooCrumb() {
    try {
      // 1) 쿠키 발급
      const r1 = await httpsRequest('https://fc.yahoo.com')
      const cookie = pickCookie(r1)
      if (!cookie) return null

      // 2) 위 쿠키를 실어서 crumb 발급
      const r2 = await httpsRequest(
        'https://query2.finance.yahoo.com/v1/test/getcrumb',
        { 'Cookie': cookie }
      )
      if (!r2 || r2.statusCode !== 200) return null

      const crumb = String(r2.body || '').trim()
      if (!crumb || crumb.length > 100) return null

      return { cookie, crumb }
    } catch (e) {
      return null
    }
  }

  async function getYahooAuth(forceRefresh) {
    if (!forceRefresh && yahooCookie && yahooCrumb) {
      return { cookie: yahooCookie, crumb: yahooCrumb }
    }
    if (yahooCrumbPromise) return yahooCrumbPromise

    yahooCrumbPromise = issueYahooCrumb().then(auth => {
      yahooCrumbPromise = null
      if (auth) {
        yahooCookie = auth.cookie
        yahooCrumb = auth.crumb
      }
      return auth || { cookie: null, crumb: null }
    })

    return yahooCrumbPromise
  }

  function buildYahooUrl(kind, param) {
    if (kind === 'search') {
      return 'https://query1.finance.yahoo.com/v1/finance/search?q=' +
        encodeURIComponent(param) + '&quotesCount=10&newsCount=0'
    }
    // kind === 'chart' (기본값)
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(param) + '?interval=1d&range=1d'
  }

  ipcMain.handle(
    'fetch-yahoo',
    async (event, kind, param) => {
      if (!param) return null

      for (let attempt = 0; attempt < 2; attempt++) {
        const auth = await getYahooAuth(attempt > 0)
        let url = buildYahooUrl(kind, param)
        if (auth && auth.crumb) {
          url += '&crumb=' + encodeURIComponent(auth.crumb)
        }

        const res = await httpsRequest(
          url,
          auth && auth.cookie ? { 'Cookie': auth.cookie } : {}
        )

        if (res && res.statusCode === 200) {
          return res.body
        }

        // 401/403이면 crumb가 만료됐을 가능성이 크므로 새로 발급받아 한 번 더 시도한다.
        if (!res || (res.statusCode !== 401 && res.statusCode !== 403)) {
          break
        }
      }

      return null
    }
  )

  // ==========================================
  // 날씨
  // ==========================================

  ipcMain.handle(
    'fetch-weather',
    async (event, lat, lon) => {

      return new Promise(resolve => {

        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FSeoul&forecast_days=1`

        https.get(
          url,
          res => {

            let data = ''

            res.on(
              'data',
              chunk => {
                data += chunk
              }
            )

            res.on(
              'end',
              () => {
                try {
                  resolve(
                    JSON.parse(data)
                  )
                } catch (e) {
                  resolve(null)
                }
              }
            )
          }
        )
        .on(
          'error',
          () => {
            resolve(null)
          }
        )
      })
    }
  )

  // ==========================================
  // 번역
  // ==========================================

  ipcMain.handle(
    'translate',
    async (event, text, from, to) => {

      return new Promise(resolve => {

        const q =
          encodeURIComponent(text)

        const url =
          `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${q}`

        https.get(
          url,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0'
            }
          },
          res => {

            let data = ''

            res.on(
              'data',
              c => {
                data += c
              }
            )

            res.on(
              'end',
              () => {

                try {

                  const j =
                    JSON.parse(data)

                  let out = ''

                  if (j && j[0]) {

                    j[0].forEach(
                      seg => {

                        if (
                          seg &&
                          seg[0]
                        ) {
                          out += seg[0]
                        }
                      }
                    )
                  }

                  resolve(
                    out || null
                  )

                } catch (e) {
                  resolve(null)
                }
              }
            )
          }
        )
        .on(
          'error',
          () => {
            resolve(null)
          }
        )
      })
    }
  )

  // ==========================================
  // 축구 경기
  // ==========================================

  ipcMain.handle(
    'fetch-football',
    async (event, league) => {

      return new Promise(resolve => {

        const today =
          new Date()

        const from =
          new Date(
            today.getTime() -
            7 * 86400000
          )
            .toISOString()
            .slice(0, 10)

        const to =
          new Date(
            today.getTime() +
            14 * 86400000
          )
            .toISOString()
            .slice(0, 10)

        const url =
          `https://api.football-data.org/v4/competitions/${league}/matches?dateFrom=${from}&dateTo=${to}`

        https.get(
          url,
          {
            headers: {
              'X-Auth-Token': '',
              'User-Agent':
                'Mozilla/5.0'
            }
          },
          res => {

            let data = ''

            res.on(
              'data',
              c => {
                data += c
              }
            )

            res.on(
              'end',
              () => {

                try {

                  const j =
                    JSON.parse(data)

                  if (
                    j.errorCode ||
                    !j.matches
                  ) {

                    resolve({
                      error:
                        'API 키가 필요해요'
                    })

                    return
                  }

                  const matches =
                    j.matches.map(
                      m => ({

                        home:
                          m.homeTeam.shortName ||
                          m.homeTeam.name,

                        away:
                          m.awayTeam.shortName ||
                          m.awayTeam.name,

                        hs:
                          m.score.fullTime.home,

                        as:
                          m.score.fullTime.away,

                        status:
                          m.status,

                        date:
                          new Date(
                            m.utcDate
                          )
                            .toLocaleDateString(
                              'ko-KR',
                              {
                                month:
                                  'numeric',

                                day:
                                  'numeric'
                              }
                            )
                      })
                    )

                  resolve({
                    matches
                  })

                } catch (e) {

                  resolve({
                    error:
                      '데이터 오류'
                  })
                }
              }
            )
          }
        )
        .on(
          'error',
          () => {

            resolve({
              error:
                '연결 실패'
            })
          }
        )
      })
    }
  )

  // ==========================================
  // 자동 시작
  // ==========================================

  ipcMain.handle(
    'get-autostart',
    async () => {

      return app
        .getLoginItemSettings()
        .openAtLogin
    }
  )

  ipcMain.handle(
    'set-autostart',
    async (event, enabled) => {

      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: []
      })

      return app
        .getLoginItemSettings()
        .openAtLogin
    }
  )

}

// ==========================================
// 앱 시작
// ==========================================

app.whenReady().then(() => {

  createWindow()

  try {

    const iconPath =
      path.join(
        __dirname,
        'icon.png'
      )

    const fs =
      require('fs')

    if (
      fs.existsSync(iconPath)
    ) {

      tray =
        new Tray(iconPath)

      const menu =
        Menu.buildFromTemplate([
          {
            label:
              'WCW 보이기',

            click: () => {

              if (win) {
                win.show()
              }
            }
          },

          {
            type:
              'separator'
          },

          {
            label:
              '종료',

            click: () => {
              app.quit()
            }
          }
        ])

      tray.setToolTip(
        'WCW 위젯'
      )

      tray.setContextMenu(
        menu
      )
    }

  } catch (e) {}
})

app.on(
  'window-all-closed',
  () => {

    if (
      process.platform !==
      'darwin'
    ) {
      app.quit()
    }
  }
)

app.on(
  'activate',
  () => {

    if (
      BrowserWindow
        .getAllWindows()
        .length === 0
    ) {
      createWindow()
    }
  }
)