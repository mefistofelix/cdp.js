import asyncio
import dateparser
import inspect
import os
import re

# print(strtotime("next month +2 days at 16:00"))
# print(strtotime("1st of next month"))
def strtotime(str="", now="now"):
    opts = {
        "RELATIVE_BASE": dateparser.parse(now),
        # "PREFER_DATES_FROM": "future",
    }
    dt = dateparser.parse(str, settings=opts)
    return dt

#v is value. Maps a-b range to c-d range
def map_range(v, a, b, c, d):
       return (v-a) / (b-a) * (d-c) + c

def go(coro):
    asyncio.create_task(coro)

def go_main(coro):
    try:
        asyncio.run(coro)
    except KeyboardInterrupt:
        pass

def file_lock(path):
    f = open(path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt; msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl; fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return f
    except OSError: f.close(); return None

def xpx(xp):
    xp = re.sub(
        r"ends-with\(([^,]+),([^)]+)\)",
        r"(substring(\1, string-length(\1)- string-length(\2) + 1) = \2)",
        xp,
    )

    xp = re.sub(
        r"icontains\(([^,]+),([^)]+)\)",
        r"contains(translate(\1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),\2)",
        xp,
    )

    return xp

class EventBus:
    def __init__(self):
        self.listeners = {}

    def on(self, events, cb, once=False):
        listener = (cb, once, inspect.iscoroutinefunction(cb), events)

        for event in events.split():
            self.listeners.setdefault(event, []).append(listener)

        return cb

    def once(self, events, cb):
        return self.on(events, cb, True)

    def once_future(self, events):
        ft = asyncio.get_running_loop().create_future()
        self.on(events, ft, True)
        # A once-listener used to survive forever when its waiter was cancelled
        # or timed out before the event arrived.  A Future owns this callback, so
        # completion/cancellation now always detaches the EventBus reference.
        ft.add_done_callback(lambda _ft: self.off(events, ft))
        return ft

    async def on_iter(self, events):
        queue = asyncio.Queue()
        listener = queue.put_nowait
        self.on(events, listener)

        try:
            while True:
                yield await queue.get()
        finally:
            self.off(events, listener)

    def off(self, events, cb):
        for event in events.split():
            self.listeners[event] = [
                listener for listener in self.listeners.get(event, [])
                if listener[0] is not cb
            ]

    def emit(self, event, data=None):
        for cb, once, async_cb, events in self.listeners.get(event, [])[:]:
            if once:
                self.off(events, cb)

            if isinstance(cb, asyncio.Future):
                if not cb.done():
                    cb.set_result((event, data))
            elif async_cb:
                asyncio.create_task(cb(data))
            else:
                cb(data)
