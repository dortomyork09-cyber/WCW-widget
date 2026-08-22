const { app, BrowserWindow, screen, ipcMain, Tray, Menu, dialog, shell, desktopCapturer, clipboard, Notification } = require('electron')
const path = require('path')
const https = require('https')
const fs = require('fs')

// electron-updater는 NSIS 설치형 빌드에서만 의미가 있고(포터블 exe는 원리상
// 자기 자신을 자동으로 갈아끼울 수 없음), package.json에 새로 추가한
// 의존성이라 아직 npm install을 안 했으면 require가 실패할 수 있다.
// 그런 경우에도 앱 자체는 정상 동작해야 하므로 통째로 try/catch로 감싼다.
let autoUpdater = null
try {
  autoUpdater = require('electron-updater').autoUpdater
} catch (e) {
  autoUpdater = null
}

// electron-builder가 포터블 exe로 실행될 때는 이 환경변수를 자동으로 심어준다.
// 이 값이 있으면 "지금 포터블로 실행 중"이라는 뜻이라, 진짜 자동 업데이트
// 대신 기존의 "새 버전 나왔어요" 안내 다이얼로그로 넘어간다.
const isPortableBuild = !!process.env.PORTABLE_EXECUTABLE_DIR

// ==========================================
// 성능: GPU 셰이더 디스크 캐시 비활성화
// ==========================================
// 일부 윈도우 환경(특히 계정 폴더 권한이 꼬였거나 백신이 잠그는 경우)에서
// 크로미움이 GPU 셰이더 컴파일 결과를 디스크에 캐시하려다 실패하면서
// "Unable to create cache" 류의 로그가 반복 발생하고, 그때마다 재시도하느라
// 초기 렌더링(창이 실제로 뜨기까지)이 느려지는 사례가 있다.
// GPU 가속 자체(위젯의 블러 효과 등)는 그대로 쓰되, 디스크에 캐시만 안 남기게
// 해서 이 지연 요인을 없앤다. app이 ready 되기 전에 호출해야 적용된다.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

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

// toISOString()은 항상 UTC라서 로그 볼 때 실제 시각이랑 안 맞아서 헷갈림 —
// 여기 시스템(사용자 PC)의 로컬 시간대 기준으로 찍히도록 직접 포맷한다.
function localTimeString() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
}

function logError(context, err) {
  try {
    const logPath = getLogPath()
    if (!logPath) return

    const time = localTimeString()
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

// ==========================================
// 새 버전 확인 (가벼운 버전 체크만, 자동 다운로드/교체는 안 함)
// ==========================================
// portable exe라 electron-updater식 완전 자동 업데이트는 안전하게 지원되지 않아서
// 대신 깃허브 최신 릴리즈랑 버전만 비교해서 알림창만 띄워준다.

function isNewerVersion(latest, current) {
  try {
    const l = String(latest).split('.').map(n => parseInt(n, 10) || 0)
    const c = String(current).split('.').map(n => parseInt(n, 10) || 0)

    for (let i = 0; i < Math.max(l.length, c.length); i++) {
      const a = l[i] || 0
      const b = c[i] || 0
      if (a > b) return true
      if (a < b) return false
    }

    return false
  } catch (e) {
    return false
  }
}

function getVersionFilePath() {
  try {
    return path.join(app.getPath('userData'), 'last-version.json')
  } catch (e) {
    return null
  }
}

function notifyIfJustUpdated() {
  try {
    const verPath = getVersionFilePath()
    if (!verPath) return

    const currentVersion = app.getVersion()
    let lastVersion = null

    if (fs.existsSync(verPath)) {
      try {
        const raw = fs.readFileSync(verPath, 'utf-8')
        const parsed = JSON.parse(raw)
        lastVersion = parsed && parsed.version ? String(parsed.version) : null
      } catch (e) {
        lastVersion = null
      }
    }

    if (lastVersion && lastVersion !== currentVersion) {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'WCW 업데이트 완료',
            body: `v${lastVersion} -> v${currentVersion}(으)로 업데이트됐어요.`,
            icon: path.join(__dirname, 'icon.png')
          }).show()
        }
      } catch (e) {
        logError('notify-updated-show', e)
      }
    }

    fs.writeFileSync(verPath, JSON.stringify({ version: currentVersion }))
  } catch (e) {
    logError('notify-updated', e)
  }
}

function checkForUpdate() {
  try {
    const options = {
      headers: {
        'User-Agent': 'WCW-App'
      },
      timeout: 8000
    }

    const req = https.get(
      'https://api.github.com/repos/dortomyork09-cyber/WCW-widget/releases/latest',
      options,
      res => {
        let data = ''

        res.on('data', chunk => {
          data += chunk
        })

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) return

            const json = JSON.parse(data)
            const latestTag = json.tag_name
            if (!latestTag) return

            const latestVersion = String(latestTag).replace(/^v/i, '')
            const currentVersion = app.getVersion()

            if (isNewerVersion(latestVersion, currentVersion)) {
              const releaseUrl =
                json.html_url ||
                'https://github.com/dortomyork09-cyber/WCW-widget/releases/latest'

              dialog
                .showMessageBox({
                  type: 'info',
                  title: 'WCW 업데이트 알림',
                  message: `새 버전(${latestVersion})이 나왔어요.\n지금 버전은 ${currentVersion}입니다.`,
                  buttons: ['다운로드 페이지 열기', '나중에'],
                  defaultId: 0,
                  cancelId: 1
                })
                .then(result => {
                  if (result.response === 0) {
                    shell.openExternal(releaseUrl)
                  }
                })
                .catch(e => logError('update-dialog', e))
            }
          } catch (e) {
            logError('update-check-parse', e)
          }
        })
      }
    )

    req.on('error', e => {
      logError('update-check-request', e)
    })

    req.on('timeout', () => {
      req.destroy()
    })
  } catch (e) {
    logError('update-check', e)
  }
}

// ==========================================
// 자동 업데이트 (NSIS 설치형 빌드 전용)
// ==========================================
// electron-updater는 GitHub Releases에 새 버전이 올라오면 백그라운드로 내려받고,
// 앱을 재시작(또는 종료)할 때 자동으로 설치해준다. 포터블 exe는 실행 파일
// 하나가 그냥 통째로 도는 구조라 "실행 중인 자기 자신을 갈아끼우는" 게 원리상
// 안 되기 때문에, 포터블 빌드에서는 이 함수가 아무것도 안 하고 기존
// checkForUpdate()의 "새 버전 나왔어요, 다운로드 페이지 열기" 안내로 대체된다.
function setupAutoUpdater() {
  if (!autoUpdater || isPortableBuild) return

  try {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('update-downloaded', info => {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'WCW 업데이트 준비됨',
            body: `v${info.version} 다운로드를 마쳤어요. 앱을 재시작하면 적용돼요.`,
            icon: path.join(__dirname, 'icon.png')
          }).show()
        }
      } catch (e) {
        logError('auto-updater-notify', e)
      }
    })

    autoUpdater.on('error', err => {
      logError('auto-updater', err)
    })

    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      logError('auto-updater-check', err)
    })
  } catch (e) {
    logError('auto-updater-setup', e)
  }
}

// ==========================================
// 다중 모니터 지원
// ==========================================
// 예전엔 getPrimaryDisplay()만 기준으로 창을 만들어서, 듀얼(또는 그 이상)
// 모니터를 쓰는 사람은 두 번째 화면에 위젯을 못 놓는 문제가 있었다.
// screen.getAllDisplays()로 모든 모니터를 감싸는 가상 데스크톱 전체 영역을
// 구해서, 창을 그 영역 전체(음수 좌표를 쓰는 모니터 배치도 포함) 크기로 만든다.
function getVirtualDesktopBounds() {
  try {
    const displays = screen.getAllDisplays()
    if (!displays || !displays.length) throw new Error('no displays')

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    displays.forEach(d => {
      const b = d.bounds
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.width)
      maxY = Math.max(maxY, b.y + b.height)
    })

    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      throw new Error('invalid bounds')
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  } catch (e) {
    // 뭔가 잘못되면(디스플레이 정보를 못 읽는 등) 최소한 기본 모니터
    // 크기로라도 창을 띄운다.
    try {
      const p = screen.getPrimaryDisplay()
      return { x: 0, y: 0, width: p.size.width, height: p.size.height }
    } catch (e2) {
      return { x: 0, y: 0, width: 1280, height: 720 }
    }
  }
}

function createWindow() {
  const vb = getVirtualDesktopBounds()

  win = new BrowserWindow({
    width: vb.width,
    height: vb.height,
    x: vb.x,
    y: vb.y,

    frame: false,
    transparent: true,
    alwaysOnTop: false,

    skipTaskbar: false,
    resizable: false,

    // 콘텐츠가 다 그려지기 전에는 숨겨뒀다가 'ready-to-show'에서 한 번에
    // 보여준다. 이게 없으면 창이 먼저 뜨고 그 위에 위젯들이 순간적으로
    // 그려지는 깜빡임(흰 화면 또는 빈 화면 잔상)이 보여서 실제 로딩
    // 시간과 별개로 "느리다"는 인상을 준다.
    show: false,

    icon: path.join(__dirname, 'icon.png'),

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.loadFile('index.html')

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) {
      win.show()
    }
  })

  // 창이 화면 전체(멀티모니터 포함)를 덮는 투명 오버레이라서, 위젯 없는
  // 빈 영역까지 항상 클릭을 먹어버리면 다른 창/바탕화면을 아예 조작할 수
  // 없게 된다. 그래서 기본값은 반드시 클릭 통과(ignore=true)여야 하고,
  // 위젯/패널 위에 있을 때만 렌더러가 false로 잠깐 풀어주는 구조를 유지한다.
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

  // 화면(index.html) 쪽 자바스크립트 에러도 같은 로그 파일에 남긴다.
  // "버튼을 눌러도 반응이 없다" 류의 문제는 대부분 여기서 잡힌다.
  ipcMain.on('renderer-error', (e, message) => {
    logError('renderer', new Error(message))
  })

  // 트레이 아이콘에 마우스를 올렸을 때 다음 알람/타이머를 보여주기 위해,
  // 렌더러가 주기적으로 계산해서 보내주는 문구를 그대로 트레이 툴팁에 반영한다.
  // 트레이 자체는 이 파일 아래쪽(app.whenReady)에서 따로 만들어지므로,
  // 여기서는 그 시점에 tray가 아직 없을 수도 있어 매번 존재 여부만 확인한다.
  ipcMain.on('update-tray-tooltip', (e, text) => {
    try {
      if (tray && !tray.isDestroyed()) {
        tray.setToolTip(
          (typeof text === 'string' && text) ? text : 'WCW 위젯'
        )
      }
    } catch (err) {}
  })

  // ==========================================
  // 뉴스 RSS
  // ==========================================

  ipcMain.handle(
    'fetch-news',
    async (event, lang) => {
      // lang이 'en'이면 영어권(미국) 뉴스, 그 외(기본)는 한국어 뉴스.
      const newsUrl =
        lang === 'en'
          ? 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en'
          : 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko'
      return new Promise(resolve => {
        https.get(
          newsUrl,
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



  // ==========================================
  // 화면 캡처 / 녹화
  // ==========================================
  // 스크린샷은 메인 프로세스에서 desktopCapturer로 화면 원본을 받아 PNG로 저장하고
  // 클립보드에도 복사한다. 녹화는 브라우저 표준 MediaRecorder API가 렌더러(화면) 쪽
  // 에서만 동작하므로, 여기서는 녹화할 화면의 소스 id만 내려주고 실제 인코딩/저장은
  // 렌더러가 하되, 완성된 파일 저장만 이 프로세스가 담당한다(파일시스템 경로 접근은
  // 메인 프로세스에서 하는 게 안전하고 일관적이라서).

  function getMediaDir() {
    const dir = path.join(app.getPath('pictures'), 'WCW')

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    } catch (e) {
      // 폴더 생성 실패 시 기본 사진 폴더로라도 저장되도록 fallback
      return app.getPath('pictures')
    }

    return dir
  }

  function timestampName() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  async function captureScreenshotToFile() {
    try {
      const display = screen.getPrimaryDisplay()
      const width = Math.round(display.size.width * display.scaleFactor)
      const height = Math.round(display.size.height * display.scaleFactor)

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })

      if (!sources || !sources.length) {
        return { success: false, error: '화면을 찾을 수 없어요' }
      }

      const img = sources[0].thumbnail
      if (!img || img.isEmpty()) {
        return { success: false, error: '캡처된 이미지가 비어있어요' }
      }

      const dir = getMediaDir()
      const filename = `WCW_캡처_${timestampName()}.png`
      const filePath = path.join(dir, filename)

      fs.writeFileSync(filePath, img.toPNG())

      try {
        clipboard.writeImage(img)
      } catch (e) {
        // 클립보드 복사가 실패해도 파일 저장은 이미 됐으니 무시
      }

      return { success: true, filename, dir, path: filePath }
    } catch (err) {
      logError('capture-screenshot', err)
      return { success: false, error: '스크린샷 캡처 중 오류가 발생했어요' }
    }
  }

  ipcMain.handle(
    'capture-screenshot',
    async () => captureScreenshotToFile()
  )

  ipcMain.handle(
    'get-screen-source',
    async () => {
      try {
        const display = screen.getPrimaryDisplay()

        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 }
        })

        if (!sources || !sources.length) {
          return null
        }

        return {
          id: sources[0].id,
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor)
        }
      } catch (err) {
        logError('get-screen-source', err)
        return null
      }
    }
  )

  ipcMain.handle(
    'save-recording',
    async (event, buffer) => {
      try {
        if (!buffer || !buffer.length) {
          return { success: false, error: '저장할 녹화 데이터가 없어요' }
        }

        const dir = getMediaDir()
        const filename = `WCW_녹화_${timestampName()}.webm`
        const filePath = path.join(dir, filename)

        fs.writeFileSync(filePath, buffer)

        return { success: true, filename, dir, path: filePath }
      } catch (err) {
        logError('save-recording', err)
        return { success: false, error: '녹화 저장 중 오류가 발생했어요' }
      }
    }
  )

  ipcMain.handle(
    'open-capture-folder',
    async () => {
      try {
        const dir = getMediaDir()
        await shell.openPath(dir)
        return { success: true }
      } catch (err) {
        logError('open-capture-folder', err)
        return { success: false }
      }
    }
  )

  ipcMain.handle(
    'open-log-folder',
    async () => {
      try {
        const logPath = getLogPath()
        if (!logPath) return { success: false, error: '로그 폴더를 열 수 없어요' }
        // 로그 파일이 있으면 탐색기에서 그 파일을 바로 선택해서 보여주고,
        // 없으면(아직 에러가 한 번도 안 난 경우) 폴더만 열어준다.
        if (fs.existsSync(logPath)) {
          shell.showItemInFolder(logPath)
        } else {
          await shell.openPath(path.dirname(logPath))
        }
        return { success: true }
      } catch (err) {
        logError('open-log-folder', err)
        return { success: false, error: '로그 폴더를 여는 중 오류가 발생했어요' }
      }
    }
  )

  // ==========================================
  // 설정 백업 내보내기 / 가져오기
  // 렌더러가 localStorage 전체를 JSON 문자열로 만들어서 넘겨주면
  // 그걸 사용자가 고른 위치에 파일로 저장/읽기만 담당한다 (내용 자체는 모른다).
  // ==========================================
  ipcMain.handle(
    'export-backup',
    async (event, jsonStr) => {
      try {
        if (typeof jsonStr !== 'string' || !jsonStr) {
          return { success: false, error: '내보낼 데이터가 없어요' }
        }
        const defaultName =
          'wcw-backup-' +
          new Date().toISOString().slice(0, 10) +
          '.json'
        const win = BrowserWindow.getAllWindows()[0]
        const result = await dialog.showSaveDialog(win, {
          title: 'WCW 백업 저장',
          defaultPath: defaultName,
          filters: [{ name: 'WCW 백업 파일', extensions: ['json'] }]
        })
        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true }
        }
        fs.writeFileSync(result.filePath, jsonStr, 'utf-8')
        return { success: true, filePath: result.filePath }
      } catch (err) {
        logError('export-backup', err)
        return { success: false, error: '백업 파일을 저장하는 중 오류가 발생했어요' }
      }
    }
  )

  ipcMain.handle(
    'import-backup',
    async () => {
      try {
        const win = BrowserWindow.getAllWindows()[0]
        const result = await dialog.showOpenDialog(win, {
          title: 'WCW 백업 불러오기',
          properties: ['openFile'],
          filters: [{ name: 'WCW 백업 파일', extensions: ['json'] }]
        })
        if (result.canceled || !result.filePaths || !result.filePaths[0]) {
          return { success: false, canceled: true }
        }
        const content = fs.readFileSync(result.filePaths[0], 'utf-8')
        return { success: true, content }
      } catch (err) {
        logError('import-backup', err)
        return { success: false, error: '백업 파일을 읽는 중 오류가 발생했어요' }
      }
    }
  )

}

// ==========================================
// 앱 시작
// ==========================================

app.whenReady().then(() => {

  createWindow()

  // 모니터를 연결/해제하거나 배치·해상도를 바꾸면 위젯을 놓을 수 있는 전체
  // 영역도 바뀌므로, 창 크기를 다시 계산해서 맞춰준다.
  function resizeWindowForDisplays() {
    try {
      if (!win || win.isDestroyed()) return
      const vb = getVirtualDesktopBounds()
      win.setBounds(vb)
    } catch (e) {
      logError('resize-window-for-displays', e)
    }
  }
  try {
    screen.on('display-added', resizeWindowForDisplays)
    screen.on('display-removed', resizeWindowForDisplays)
    screen.on('display-metrics-changed', resizeWindowForDisplays)
  } catch (e) {
    logError('display-listener-register', e)
  }

  // 창이 뜨고 조금 지난 뒤, 지난 실행 때와 버전이 달라졌으면(=방금 업데이트를
  // 끝낸 상태) 완료 알림을 띄운다.
  setTimeout(() => {
    notifyIfJustUpdated()
  }, 2000)

  // 시작하고 3초 후에 새 버전 있는지 확인 (부팅 직후 부하 안 주려고 살짝 지연).
  // NSIS 설치형으로 실행 중이고 electron-updater가 설치돼있으면 진짜 자동
  // 업데이트를, 아니면(포터블 exe) 기존의 "새 버전 나왔어요" 안내만 띄운다.
  setTimeout(() => {
    if (!isPortableBuild && autoUpdater) {
      setupAutoUpdater()
    } else {
      checkForUpdate()
    }
  }, 3000)

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

      function sendTrayAction(action) {
        if (win && !win.isDestroyed()) {
          win.show()
          win.webContents.send('tray-action', action)
        }
      }

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
            label: '위젯 추가...',
            click: () => sendTrayAction('open-modal')
          },

          {
            label: '설정 열기',
            click: () => sendTrayAction('open-settings')
          },

          {
            label: '배치 잠금 켜기/끄기',
            click: () => sendTrayAction('toggle-lock')
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