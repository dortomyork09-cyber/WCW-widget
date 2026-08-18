const { app, BrowserWindow, screen, ipcMain, Tray, Menu } = require('electron')
const path = require('path')
const https = require('https')
const fs = require('fs')

let win = null
let tray = null

// ==========================================
// 에러 로그
// ==========================================
// 앱이 죽거나 예상 못한 에러가 나면 로그 파일에 남긴다.
// 로그 남기는 과정 자체에서 에러가 나도 앱은 계속 돌아가야 하므로
// 이 파일 안의 모든 동작은 try/catch로 감싼다.

function getLogPath() {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    return path.join(logDir, 'error.log')
  } catch (e) {
    return null
  }
}

function logError(context, err) {
  try {
    const logPath = getLogPath()
    if (!logPath) return

    const time = new Date().toISOString()
    const message = err && err.stack ? err.stack : String(err)
    const line = `[${time}] [${context}] ${message}\n`

    fs.appendFileSync(logPath, line)

    // 로그 파일이 너무 커지면 잘라낸다 (1MB 넘으면 초기화)
    const stat = fs.statSync(logPath)
    if (stat.size > 1024 * 1024) {
      fs.writeFileSync(logPath, line)
    }
  } catch (e) {
    // 로그 자체가 실패해도 무시 — 앱 동작에 영향 주면 안 됨
  }
}

process.on('uncaughtException', (err) => {
  logError('uncaughtException', err)
})

process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason)
})

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
    try {
      if (win && !win.isDestroyed()) {
        win.setIgnoreMouseEvents(ignore, {
          forward: true
        })
      }
    } catch (err) {
      // 창이 이미 닫혔거나 일시적인 OS 오류인 경우 무시
    } finally {
      // sendSync로 호출된 경우 렌더러가 응답을 기다리므로
      // 반드시 returnValue를 채워줘야 함 (안 그러면 렌더러가 멈춤)
      e.returnValue = true
    }
  })

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
      try {
        return app
          .getLoginItemSettings()
          .openAtLogin
      } catch (err) {
        return false
      }
    }
  )

  ipcMain.handle(
    'set-autostart',
    async (event, enabled) => {
      try {
        app.setLoginItemSettings({
          openAtLogin: !!enabled,
          path: process.execPath,
          args: []
        })
      } catch (err) {
        // 일부 환경(권한 제한 등)에서 등록 실패 가능 - 무시하고
        // 실제 반영된 상태를 그대로 반환해 UI가 항상 실제 상태와 일치하게 함
      }

      try {
        return app
          .getLoginItemSettings()
          .openAtLogin
      } catch (err) {
        return false
      }
    }
  )

}

// ==========================================
// 앱 시작
// ==========================================

app.whenReady().then(() => {

  createWindow()

  // 렌더러(화면) 프로세스가 죽으면 왜 죽었는지 로그로 남긴다
  app.on('render-process-gone', (event, webContents, details) => {
    logError(
      'render-process-gone',
      new Error(`reason: ${details.reason}, exitCode: ${details.exitCode}`)
    )
  })

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