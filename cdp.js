//https://chromedevtools.github.io/devtools-protocol/
//https://github.com/puppeteer/puppeteer/issues/3339
//https://github.com/chromedp/chromedp/issues/184
/*
https://github.com/ulixee/unblocked/blob/23221f2f24601d14e4dca1d65f45eba25f155149/agent/main/lib/BrowserProcess.ts
https://github.com/microsoft/playwright/blob/1539cde0343a19bfa590478cb13bb9aeff905180/packages/playwright-core/src/server/chromium/chromium.ts#L281
https://github.com/microsoft/playwright/blob/1539cde0343a19bfa590478cb13bb9aeff905180/packages/playwright-core/src/server/pipeTransport.ts#L22
https://github.com/microsoft/playwright/blob/1539cde0343a19bfa590478cb13bb9aeff905180/packages/playwright-core/src/utils/processLauncher.ts#L132
https://stackoverflow.com/questions/53039551/selenium-webdriver-modifying-navigator-webdriver-flag-to-prevent-selenium-detec/69533548#69533548
https://bot.sannysoft.com/
https://squirrelistic.com/blog/how_to_download_older_version_of_google_chrome
https://pawprint.dev

"C:\Program Files\Google\Chrome\Application\chrome.exe"
--disable-field-trial-config
--disable-background-networking
--enable-features=NetworkService,NetworkServiceInProcess
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-back-forward-cache
--disable-breakpad
--disable-client-side-phishing-detection
--disable-component-extensions-with-background-pages
--disable-component-update
--no-default-browser-check
--disable-default-apps
--disable-dev-shm-usage
--disable-extensions
--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding
--allow-pre-commit-input
--disable-hang-monitor
--disable-ipc-flooding-protection
--disable-popup-blocking
--disable-prompt-on-repost
--disable-renderer-backgrounding
--force-color-profile=srgb
--metrics-recording-only
--no-first-run
--enable-automation
--password-store=basic
--use-mock-keychain
--no-service-autorun
--export-tagged-pdf
--disable-search-engine-choice-screen
--no-sandbox
--enable-automation
--user-data-dir=C:\Users\Michele\Desktop\hero-cloud/prof
--remote-debugging-pipe about:blank

// import Hero from '@ulixee/hero-playground'
// var opts = {
//   userAgent: '~ chrome',
//   locale: 'it-IT',
//   timezoneId: 'Europe/London',
//   showChromeInteractions: true,
//   sessionPersistence: true,
// }
// var hero = new Hero(opts)
// await hero.goto(url)
// await sleep(1000)
// await hero.close()

import * as pw from 'playwright'
let opts = {
  headless: false,
  viewport: null,
  executablePath: chrome_path,
  ignoreDefaultArgs: true,
  args: [
    '--enable-automation',
    r`--user-data-dir=${profdir}`,
    '--remote-debugging-pipe',
    '--disable-blink-features=AutomationControlled',
  ]
}
//let browser = await pw.chromium.launch(opts)
//let ctx = await browser.newContext()
let ctx = await pw.chromium.launchPersistentContext(profdir,opts)
await sleep(5)
let page = await ctx.newPage()
await page.goto(url)
await sleep(1000)
await ctx.close()
//await browser.close()
process.exit()
*/

import * as child_process from 'node:child_process'
import * as os from 'node:os'
let r = String.raw

import x from './x.js'

class wsjrpc extends WebSocket {
  constructor(...args) {
    //console.log("jrpc.constructor")
    super(...args)
    this.jrpc_id = 0
    this.addEventListener('message',this._onmessage)
  }
  _onmessage(e) {
    let resp = JSON.parse(e.data)
    //console.log(resp)
    if(resp.id) {
      let rpce_id = new CustomEvent(`rpc_${resp.id}`,{detail:resp})
      //console.dir(rpce_id)
      this.dispatchEvent(rpce_id)
    }
    else {
      let rpce = new CustomEvent('notify',{detail:resp})
      this.dispatchEvent(rpce)
    }
  }
  async on_first(ev_name) {
    let ep, ep_res
    let ecb = function (ev) {
      if (ep_res) ep_res(ev)
      ep = new Promise(function (res) {
        ep_res = res
      })
    }
    ecb()
    this.addEventListener(ev_name, ecb)
    try {
      yield await ep
    } finally {
      this.removeEventListener(ev_name, ecb)
    }
  }
  async req(req) {
    if(!req.id) {
      this.jrpc_id += 1
      req.id = this.jrpc_id
    }
    //console.log(req)
    let jreq = JSON.stringify(req)
    this.send(jreq)
    let ret = await this.on_first(this,`rpc_${req.id} close`)
    if(ret.type == 'close') return
    //console.dir(ret)
    ret = ret.detail
    if(ret.error) throw new Error(ret.error.message,{cause: {req, ret}})
    return ret.result
  }
  notify(req) {
    let jreq = JSON.stringify(req)
    this.send(jreq)
  }
}

class wscdp extends wsjrpc {
  constructor(...args) {
    super(...args)
    this.targets = {}
    this.sid_to_page = {}
    this.addEventListener('notify',this._onnotify)
  }
  _onnotify(e) {
    e = e.detail
    let sid = e?.sessionId
    let tid = e?.params?.targetInfo?.targetId
    let page = this.sid_to_page[sid]

    if(tid && e.method == 'Target.attachedToTarget') {
      let attach_sid = e?.params?.sessionId
      //console.log('attach',tid,attach_sid)
      this.targets[tid] = e.params
    }

    //console.log(page,e)
    if(page) {
      //console.log(e)
      let ce = new CustomEvent('notify',{detail:e})
      page.dispatchEvent(ce)
    }
  }
  async init() {
    await x.on_first(this,'open')
    await this.call('Target.setAutoAttach',{
      autoAttach:true,
      flatten:true,
      waitForDebuggerOnStart:false
    })
  }
  async call(method,params) {
    let req = {
      method,
      params
    }
    let _tid = params?._targetId
    delete params?._targetId
    if(_tid && !req.sessionId) {
      req.sessionId = this.targets[_tid].sessionId
    }
    //console.log(req)
    let ret = await this.req(req)
    return ret
  }
  async createTarget() {
    let page = new cdp_page()
    page.wscdp = this
    //console.log('create target')
    let ct_resp = await this.call('Target.createTarget',{
      url:'about:blank',
      background: true
    })
    page.tid = ct_resp.targetId
    page.sid = this.targets[page.tid].sessionId
    this.sid_to_page[page.sid] = page
    //console.log('new page',page.tid,page.sid)

    await page.call('Runtime.enable') //required for Runtime.addBinding and others
    await page.call('Page.enable') //required for Page.addScriptToEvaluateOnNewDocument
    await page.call('Network.enable')
    await page.call('ServiceWorker.enable')
    //await page.call('Debugger.disable')
    //setTimeout(function(){debugger;},0)
    //let ret = wscdp.call('Page.waitForDebugger',{
    //  _targetId: page.targetId,
    //})

    await page.call('Emulation.setFocusEmulationEnabled',{ enabled: true }) //page always active even if minimized or not focused
    await page.call('Runtime.addBinding',{ name: '_send_to_cdp' })
    await page.call('Runtime.runIfWaitingForDebugger')

    await page.call('BackgroundService.clearEvents',{ service: 'pushMessaging' })
    await page.call('BackgroundService.startObserving',{ service: 'pushMessaging' })
    await page.call('BackgroundService.setRecording',{ service: 'pushMessaging', shouldRecord: true })

    return page
  }
}

class cdp_page extends EventTarget {
  constructor() {
    super()
    this.wscdp = null
    this.tid = null
    this.sid = null
  }
  async call(method,params) {
    if(!params) params = {}
    params._targetId = this.tid
    //params.sessionId = this.sid
    return this.wscdp.call(method,params)
  }
  xpx(xp) {
    let ew_rx = /ends-with\(([^,]+),([^\)]+)\)/gm
    let ew_subst = `(substring($1, string-length($1)- string-length($2) + 1) = $2)`
    xp = xp.replace(ew_rx,ew_subst)

    let ic_rx = /icontains\(([^,]+),([^\)]+)\)/gm;
    let ic_subst = `contains(translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),$2)`;
    xp = xp.replace(ic_rx,ic_subst)

    return xp
  }
  async click(xp_sel) {
    xp_sel = this.xpx(xp_sel)
    //https://github.com/cyrus-and/chrome-remote-interface/issues/222
    //document.evaluate(".//a[contains(@href,'followers_you_follow')]",document).iterateNext()
    //document.evaluate(".//a[@href='/sugarsmorecake/followers_you_follow']",document)?.iterateNext()
    let ret = await this.call('Runtime.evaluate',{
      returnByValue: true,
      awaitPromise: true,
      //disableBreaks: true,
      //allowUnsafeEvalBlockedByCSP: true,
      silent: true,
      userGesture: true,
      // expression:`
      //   document.evaluate("${xp_sel}",document)?.iterateNext()?.click()
      // `,
      expression:`
        {
          let Promise = ((async function () {})().constructor)
          let resolve
          let p = new Promise(function(res,rej){resolve=res})
          //---------------------
          let i = 0
          function click() {
            let el = document.evaluate("${xp_sel}",document)?.iterateNext()
            if(!el) {
              i += 1
              if(i>4) {
                //console.log('fail')
                resolve(false)
                return
              }
              //console.log('retry',i)
              setTimeout(click,300)
              return
            }
            //console.log('clicked',el)
            el?.click()
            resolve(true)
          }
          click()
          //---------------------
          p
        }
      `
    })
    //console.log(ret)
    return ret?.result
    //await this.call('Input.dispatchMouseEvent',{type:'mousePressed',x:,y:})
    //await this.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:,y:})
  }
}

async function launch(user_data_dir,chrome_path) {
  if(!chrome_path) {
    chrome_path = os.type()=='Windows_NT'?
      r`C:\Program Files\Google\Chrome\Application\chrome.exe`:
      r`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  }
  //let chrome_path = r`C:\Program Files\Google\Chrome\Application\chrome.exe`
  //let user_data_dir = `${import.meta.dirname}/prof`
  let args = [
    '--enable-automation',
    `--user-data-dir=${user_data_dir}`,
    //'--remote-debugging-pipe',
    '--remote-debugging-port=1234',
    //'--remote-debugging-address=0.0.0.0', //works only in headless mode
    '--mute-audio',
    //'--disable-gl-drawing-for-tests', //faster rendering (totally black window)
    //'--blink-settings=imagesEnabled=false', //disable images (!cloudflare)
    '--disable-blink-features=AutomationControlled', //!!!!!
    '--hide-crash-restore-bubble',
    //from playwright: (added InfiniteSessionRestore)
    '--disable-field-trial-config',
    '--disable-background-networking',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-back-forward-cache',
    '--disable-breakpad ',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=InfiniteSessionRestore,ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding',
    '--allow-pre-commit-input',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-first-run',
    '--password-store=basic',
    '--use-mock-keychain',
    '--no-service-autorun',
    '--export-tagged-pdf',
    '--disable-search-engine-choice-screen',
    '--no-sandbox',
    '--ignore-certificate-errors',
    //'--no-zygote',
  ]
  let opts = {}
  let bro_proc = child_process.spawn(chrome_path,args,opts)
  await x.on_first(bro_proc,'spawn')
  //for await(let ed of x.on(bro_proc, '*')) {
  //  console.dir(ed.detail)
  //}

  let resp
  while(1) {
    try {
      await x.sleep(0.2)
      resp = await fetch('http://127.0.0.1:1234/json/version')
      resp = await resp.json()
      //console.log(resp)
      //console.log(resp.webSocketDebuggerUrl)
      break
    }
    catch {}
    finally{}
  }

  let cdp = new wscdp(resp.webSocketDebuggerUrl)
  await cdp.init()

  return [bro_proc, cdp]
}

//-----------------------------------------------------------------------------------------
/*
async function chrome_download() {
  let upd_url = 'https://tools.google.com/service/update2'
  let app_id = '8A69D345-D564-463C-AFF1-A69D9E530F96'
  let chrome_ver = '124'
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <request
      updater="Omaha"
    >
      <os
        platform="win"
        version="10.0"
        arch="x64"
      />
      <app
        appid="{${app_id}}"
        lang=""
      >
        <updatecheck targetversionprefix="${chrome_ver}" />
      </app>
    </request>
  `
  let headers = {
    //'Content-Type': 'application/x-www-form-urlencoded',
    //'X-Goog-Update-Interactivity': 'fg'
  }
  console.log(xml)
  let resp = await fetch(upd_url,{
      method: 'POST',
      headers: headers,
      body: xml
  })
  resp = await resp.text()
  console.log(resp)
}

async function chrome_launch() {
  let chrome_path = r`C:\Program Files\Google\Chrome\Application\chrome.exe`
  let profdir = r`${__dirname}/prof`
  let args = [
    '--enable-automation',
    r`--user-data-dir=${profdir}`,
    //'--remote-debugging-pipe',
    '--remote-debugging-port=1234',
    //'--remote-debugging-address=0.0.0.0', //works only in headless mode
    '--mute-audio',
    //'--disable-gl-drawing-for-tests', //faster rendering (totally black window)
    '--blink-settings=imagesEnabled=false', //disable images
    '--disable-blink-features=AutomationControlled',
  ]
  let opts = {}
  let bro_proc = child_process.spawn(chrome_path,args,opts)
  await on(bro_proc,'spawn').next()

  let resp
  while(1) {
    try {
      await sleep(0.2)
      resp = await fetch('http://127.0.0.1:1234/json/version')
      resp = await resp.json()
      console.log(resp)
      console.log(resp.webSocketDebuggerUrl)
      break
    }
    finally{}
  }

  //let ws_url = new URL(resp.webSocketDebuggerUrl)
  //console.log(ws_url)
  //console.log(ws_url.pathname)
  //let ws = await cli.upgrade({path:ws_url.pathname})

  let ws = new WebSocket(resp.webSocketDebuggerUrl)
  await on(ws, 'open').next()
  ws.send("aaaa")
  for await(let ed of on(ws, '*')) {
    console.dir(ed[1])
    console.log(ed[1].type)
    console.log(ed[1].data)
  }
}*/

let cdp = {
  //wsjrpc,
  wscdp,
  launch
}

export default cdp
