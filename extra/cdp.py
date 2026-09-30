import asyncio
import base64
import curl_cffi
import json
import pathlib
import platform
import zlib
from .jrpc import jrpc
from . import x


class cdp(x.EventBus):
    def __init__(self, base_path=None, chrome_path=None, extensions=True, images=True, headless=False):
        super().__init__()
        self.base_path = pathlib.Path(base_path).resolve() if base_path else None
        self.chrome_path = chrome_path
        self.extensions = extensions
        self.images = images
        self.headless = headless
        self.browsers = {}
        self.task = None

    def on_notify(self, browser, msg):
        params = msg.setdefault("params", {})
        method = msg["method"]
        sid = msg.get("sessionId") or params.get("sessionId")
        tid = params.get("targetInfo", {}).get("targetId") or params.get("targetId")

        if tid and method == "Target.attachedToTarget":
            browser.target_info[tid] = params
            label = next((
                label for label, value in browser.targets.items()
                if value["targetId"] == tid
            ), None)
            if label:
                target = browser.targets[label]
                old_sid = target.get("sessionId")
                if old_sid:
                    browser.sid_to_target.pop(old_sid, None)
                target["sessionId"] = params["sessionId"]
                browser.sid_to_target[params["sessionId"]] = label
            browser.emit(f"attached_{tid}", params)

            info = params.get("targetInfo", {})
            if info.get("openerId"):
                asyncio.create_task(browser.call({
                    "method": "Runtime.runIfWaitingForDebugger",
                    "sessionId": params["sessionId"],
                }))

        params["browser"] = browser.label
        target = browser.sid_to_target.get(sid)
        if not target and tid:
            target = next((
                label for label, value in browser.targets.items()
                if value["targetId"] == tid
            ), None)

        if target:
            params["target"] = target
            msg.pop("sessionId", None)

        self.emit("notify", msg)
        self.emit(method, params)

        if target and method == "Target.detachedFromTarget":
            browser.sid_to_target.pop(sid, None)
            browser.target_info.pop(browser.targets[target]["targetId"], None)
            if browser.targets[target].get("sessionId") == sid:
                browser.targets[target]["sessionId"] = None

        if target and method in {"Target.targetCrashed", "Target.targetDestroyed"}:
            value = browser.targets.pop(target, None)
            if value:
                browser.sid_to_target.pop(value.get("sessionId"), None)
                browser.target_info.pop(value["targetId"], None)

    async def call(self, method, params=None):
        params = dict(params or {})
        browser_label = params.pop("browser", "main")
        if method == "click":
            params["browser"] = browser_label
            return await self.click(params)

        if method == "screenshot":
            return await self.screenshot(
                params.pop("url"),
                params.pop("path"),
                browser_label,
                params.pop("target", "screenshot"),
            )

        target_label = params.pop("target", None)
        for attempt in range(2):
            browser = self.browsers.get(browser_label)
            if not browser or browser.task.done():
                browser = await self.create_browser(browser_label)

            target = None
            if target_label is not None:
                if target_label not in browser.targets:
                    initial_url = params.get("url") if method == "Page.navigate" else "about:blank"
                    await self.create_target(browser, target_label, initial_url)
                target = browser.targets.get(target_label)
                if target is None:
                    return
                if not target.get("sessionId"):
                    info = browser.target_info.get(target["targetId"])
                    if not info:
                        event, info = await browser.once_future(f'attached_{target["targetId"]} close')
                        if event == "close":
                            return
                    target["sessionId"] = info["sessionId"]
                    browser.sid_to_target[target["sessionId"]] = target_label

            req = {"method": method}
            if params:
                req["params"] = params
            if target is not None:
                req["sessionId"] = target["sessionId"]

            try:
                ret = await browser.call(req)
            except Exception as exc:
                message = str(exc).lower()
                stale = target is not None and any(value in message for value in (
                    "no session with given id",
                    "session with given id not found",
                    "target closed",
                    "target with given id",
                ))
                if attempt or not stale:
                    raise
                browser.targets.pop(target_label, None)
                browser.sid_to_target.pop(target["sessionId"], None)
                browser.target_info.pop(target["targetId"], None)
                return

            if ret:
                return ret.get("result")
            if attempt or not browser.task.done():
                return

    async def create_target(self, browser, label, url="about:blank"):
        ret = await self.call("Target.createTarget", {
            "browser": browser.label,
            "url": url,
            "background": True,
        })

        if ret is None:
            return

        tid = ret["targetId"]

        if tid not in browser.target_info:
            event, _ = await browser.once_future(f"attached_{tid} close")

            if event == "close":
                return

        target = {
            "targetId": tid,
            "sessionId": browser.target_info[tid]["sessionId"],
        }
        browser.targets[label] = target
        browser.sid_to_target[target["sessionId"]] = label

        for startup_tid in browser.startup_targets:
            if startup_tid == tid:
                continue
            await self.call("Target.closeTarget", {
                "browser": browser.label,
                "targetId": startup_tid,
            })
        browser.startup_targets = []

        await self.call("Runtime.enable", {"browser": browser.label, "target": label})
        await self.call("Page.enable", {"browser": browser.label, "target": label})
        await self.call("Network.enable", {"browser": browser.label, "target": label})
        await self.call("ServiceWorker.enable", {"browser": browser.label, "target": label})

        await self.call("Emulation.setFocusEmulationEnabled", {
            "browser": browser.label,
            "target": label,
            "enabled": True,
        })

        await self.call("Runtime.addBinding", {
            "browser": browser.label,
            "target": label,
            "name": "_send_to_cdp",
        })

        #await self.call("Runtime.disable", {"browser": browser.label, "target": label})

        await self.call("Runtime.runIfWaitingForDebugger", {"browser": browser.label, "target": label})

        await self.call("BackgroundService.clearEvents", {
            "browser": browser.label,
            "target": label,
            "service": "pushMessaging",
        })

        await self.call("BackgroundService.startObserving", {
            "browser": browser.label,
            "target": label,
            "service": "pushMessaging",
        })

        await self.call("BackgroundService.setRecording", {
            "browser": browser.label,
            "target": label,
            "service": "pushMessaging",
            "shouldRecord": True,
        })

        return target

    async def click(self, params):
        params = dict(params)
        browser = params.pop("browser")
        target = params.pop("target")
        xp = json.dumps(x.xpx(params.pop("xp")))

        expression = f"""
        (async () => {{
            for(let i = 0; i < 5; i++) {{
                let el = document.evaluate({xp}, document)?.iterateNext()

                if(el) {{
                    el.click()
                    return true
                }}

                await new Promise(resolve => setTimeout(resolve, 300))
            }}

            return false
        }})()
        """

        ret = await self.call("Runtime.evaluate", {
            "browser": browser,
            "target": target,
            "returnByValue": True,
            "awaitPromise": True,
            "silent": True,
            "userGesture": True,
            "expression": expression,
        })

        if ret:
            return ret.get("result")

    async def screenshot(self, url, path, browser="main", target="screenshot"):
        await self.call("Page.navigate", {
            "browser": browser,
            "target": target,
            "url": url,
        })

        for _ in range(100):
            ret = await self.call("Runtime.evaluate", {
                "browser": browser,
                "target": target,
                "expression": "document.readyState",
                "returnByValue": True,
            })

            if ret and ret.get("result", {}).get("value") == "complete":
                break

            await asyncio.sleep(.1)

        ret = await self.call("Page.captureScreenshot", {
            "browser": browser,
            "target": target,
            "format": "webp",
            "fromSurface": True,
        })

        if not ret:
            return

        path = pathlib.Path(path)
        path.write_bytes(base64.b64decode(ret["data"]))
        return path

    async def create_browser(self, label):
        browser = self.browsers.get(label)

        if browser:
            await browser.close()

            if browser.proc.returncode is None:
                browser.proc.terminate()
                await browser.proc.wait()

        chrome_path = self.chrome_path or {
            "Windows": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            "Darwin": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        }[platform.system()]
        user_data_dir = self.base_path / label
        port = 12000 + zlib.crc32(label.encode()) % 1000
        browser = jrpc()
        browser.label = label
        browser.targets = {}
        browser.target_info = {}
        browser.sid_to_target = {}
        browser.startup_targets = []
        browser.on("notify", lambda msg: self.on_notify(browser, msg))
        browser.on("close", lambda code: self.emit("close", {
            "browser": label,
            "code": code,
        }))

        args = [
            "--enable-automation",
            f"--user-data-dir={user_data_dir}",
            f"--remote-debugging-port={port}",
            "--mute-audio",
            "--disable-blink-features=AutomationControlled",
            "--hide-crash-restore-bubble",
            "--disable-field-trial-config",
            "--disable-background-networking",
            "--enable-features=NetworkService,NetworkServiceInProcess",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-back-forward-cache",
            "--disable-breakpad",
            "--disable-client-side-phishing-detection",
            "--disable-component-extensions-with-background-pages",
            "--disable-component-update",
            "--no-default-browser-check",
            "--disable-default-apps",
            "--disable-dev-shm-usage",

            "--allow-browser-signin=false",
            "--disable-signin-promo-on-avatar-pill-for-testing",
            "--disable-features=InfiniteSessionRestore,ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,TranslateToast,EnableTranslatePdf,HttpsUpgrades,PaintHolding,DiceWebSigninInterception,SigninPromoOnAvatarPill",
            "--disable-sync",
            "--allow-pre-commit-input",
            "--disable-hang-monitor",
            "--disable-ipc-flooding-protection",
            "--disable-popup-blocking",
            "--disable-prompt-on-repost",
            "--force-color-profile=srgb",
            "--metrics-recording-only",
            "--no-first-run",
            "--password-store=basic",
            "--use-mock-keychain",
            "--no-service-autorun",
            "--export-tagged-pdf",
            "--disable-search-engine-choice-screen",
            "--no-sandbox",
            "--ignore-certificate-errors",
        ]

        if not self.extensions:
            args.append("--disable-extensions")

        if self.headless:
            args.extend(("--headless=new", "--window-size=1440,900"))

        args.append(f"--blink-settings=imagesEnabled={'true' if self.images else 'false'}")

        browser.proc = await asyncio.create_subprocess_exec(chrome_path, *args)

        async with curl_cffi.AsyncSession() as session:
            while True:
                try:
                    version = (await session.get(f"http://127.0.0.1:{port}/json/version")).json()
                    break
                except Exception:
                    await asyncio.sleep(.2)

        await browser.connect(version["webSocketDebuggerUrl"])
        await browser.call({
            "method": "Target.setAutoAttach",
            "params": {
                "autoAttach": True,
                "flatten": True,
                #"waitForDebuggerOnStart": True,
                "waitForDebuggerOnStart": False,
            },
        })
        targets = await browser.call({"method": "Target.getTargets"})
        browser.startup_targets = [
            value["targetId"]
            for value in targets.get("result", {}).get("targetInfos", [])
            if value.get("type") == "page"
            and value.get("url") in {"about:blank", "chrome://newtab/"}
        ]

        settings = await browser.call({
            "method": "Target.createTarget",
            "params": {"url": "chrome://settings/", "background": True},
        })
        settings_tid = settings["result"]["targetId"]

        if settings_tid not in browser.target_info:
            event, _ = await browser.once_future(f"attached_{settings_tid} close")
            if event == "close":
                return

        settings_sid = browser.target_info[settings_tid]["sessionId"]

        for _ in range(20):
            ready = await browser.call({
                "method": "Runtime.evaluate",
                "sessionId": settings_sid,
                "params": {
                    "expression": "typeof chrome?.settingsPrivate?.setPref === 'function'",
                    "returnByValue": True,
                },
            })
            if ready.get("result", {}).get("result", {}).get("value"):
                break
            await asyncio.sleep(.05)

        await browser.call({
            "method": "Runtime.evaluate",
            "sessionId": settings_sid,
            "params": {
                "expression": "new Promise(r => chrome.settingsPrivate.setPref('translate.enabled', false, '', r))",
                "awaitPromise": True,
                "returnByValue": True,
            },
        })
        await browser.call({
            "method": "Target.closeTarget",
            "params": {"targetId": settings_tid},
        })

        self.browsers[label] = browser

        if label == "main":
            self.task = browser.task

        return browser

    async def close(self):
        for browser in list(self.browsers.values()):
            await browser.close()

            if browser.proc.returncode is None:
                browser.proc.terminate()
                await browser.proc.wait()

        self.browsers.clear()
        self.task = None
