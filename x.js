//let dirname = `${import.meta.dirname}`

//https://stackoverflow.com/questions/4048204/javascript-equivalent-of-phps-strtotime
//https://github.com/locutusjs/locutus
//https://github.com/wanasit/chrono
//https://wanasit.github.io/chrono/

//import * as child_process from 'node:child_process'
import * as crypto from "node:crypto";
import EventEmitter from "node:events";
import fs from "node:fs";
let r = String.raw;

//-----------------------------------------------------------------------------------------

function sc(s) {
  //console.log(arguments)
  return s.replaceAll(/^[ \t]+/gim, "")?.trim();
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

//https://stackoverflow.com/questions/32510114/remove-duplicates-algorithm-in-place-and-stable-javascript
//https://stackoverflow.com/questions/31547315/is-it-an-antipattern-to-set-an-array-length-in-javascript
function array_unique(arr) {
  var seen = {};
  var k = 0;
  for (let i in arr) {
    let v = arr[i];
    if (seen[v]) continue;
    arr[k++] = v;
    seen[v] = true;
  }
  arr.length = k;
  return arr;
}

function object_sort(o, f) {
  //https://stackoverflow.com/questions/2636453/is-it-possible-to-create-a-non-enumerable-property-in-javascript
  let keys_wm = new WeakMap();
  let vals = [];
  let keys = Object.keys(o);
  for (let k of keys) {
    let v = o[k];
    keys_wm.set(v, k);
    vals.push(v);
  }
  vals.sort(function (a, b) {
    let ka = keys_wm.get(a);
    let kb = keys_wm.get(b);
    return f(a, b, ka, kb);
  });
  let ret = {};
  for (let v of vals) {
    let k = keys_wm.get(v);
    ret[k] = v;
  }
  //console.log(ret)
  return ret;
}

function object_first(o) {
  for (let k in o) {
    let v = o[k];
    let ret = [v, k];
    //console.log(ret)
    return ret;
    break;
  }
}

function clone(v) {
  return structuredClone(v);
}

async function dfs(o, cb) {
  let iter = async function* (o, k, kp) {
    yield o;

    if (!Array.isArray(kp)) kp = k ? [k] : [];
    //console.log(kp)

    if (cb) {
      let cb_ret = cb(o, k);
      if (typeof cb_ret != "undefined") o = cb_ret;
    }

    if (
      !Array.isArray(o) &&
      !(
        typeof o == "object" &&
        o &&
        [undefined, Object].includes(o.constructor)
      )
      //!o?.[Symbol.iterator]
    )
      return;

    for (let sk in o) {
      //console.log(k)
      let v = o[sk];
      kp.push(sk);
      yield* await iter(v, sk, kp);
      kp.pop();
    }
  };
  for await (let item of iter(o)) {
  }
  //yield* await iter(o)
}

function $(root) {
  if (!root) root = {};
  let px_handler = {
    //root: root,
    path: [],
    get(obj, prop, receiver) {
      //console.log('get',obj,prop)
      if (prop == "toJSON") {
        //console.log('get toJSON nostring',arguments)
        throw "NO3";
        //return () => root
      }
      if (typeof prop != "string") {
        //console.log('get nostring',arguments)
        //return Reflect.get(root,prop,root)
        throw "NO1";
      }
      let ret = px;
      this.path.push(prop);
      if (prop == "$") {
        this.path.pop();
        //console.log(this.path)
        let r = root;
        let plen = this.path.length;
        let ik = 0;
        while (1) {
          let k = this.path[ik];
          let k_is_last = ++ik >= plen;
          //console.log(ik,k,k_is_last,r)
          if (k_is_last) {
            break;
          }
          r = r?.[k];
        }
        ret = r;
        this.path = [];
      }
      return ret;
    },
    set(obj, prop, value) {
      this.path.push(prop);
      //console.log('set',obj,prop,'$$')
      if (prop != "$" && prop != "$$") {
        throw "NO2";
        //return false
      }
      if (prop == "$" || prop == "$$") {
        this.path.pop();
        let is_append = prop == "$$";
        //console.log('set',this.path)
        let r = root;
        let plen = this.path.length;
        let ik = 0;
        while (1) {
          let k = this.path[ik];
          let nk = this.path?.[ik + 1];
          let k_is_last = ++ik >= plen;
          //console.log(k,ik+1,this.path.length,k_is_last)
          if (is_append && k_is_last) {
            r[k] = [];
          }
          if (k_is_last) {
            if (is_append) r[k].push(value);
            else r[k] = value;
            break;
          }
          let nk_array = !isNaN(parseInt(nk));
          let is_cnt = Array.isArray(r?.[k]) || typeof r?.[k] == "object";
          if (!is_cnt) {
            r[k] = nk_array ? [] : {};
          }
          r = r[k];
        }
        this.path = [];
      }
      return true;
    },
  };
  let px = new Proxy(root, px_handler);
  return px;
}

function empty(v) {
  //debugger
  let t = typeof v;
  if (t == "undefined") return true;
  if (t === null) return true;
  if (t == "number" && isNaN(v)) return true;
  if ((t == "string" || v instanceof String) && !v.length) return true;
  if (Array.isArray(v) && !v.length) return true;
  if (
    t == "object" &&
    v &&
    [undefined, Object].includes(v.constructor) &&
    !Object.keys(v).length
  )
    return true;
  return v ? false : true;
}

function sleep(s) {
  return new Promise((r) => setTimeout(r, s * 1000));
}

//-----------------------------------------------------------------------------------------

async function* on(em, ev_name) {
  let ep, ep_res;
  let ecb = function (ev) {
    if (ep_res) ep_res(ev);
    ep = new Promise(function (res) {
      ep_res = res;
    });
    //;({ promise:ep, resolve: ep_res } = Promise.withResolvers())
  };
  ecb();

  let mode, addl, reml;
  if (typeof EventTarget != "undefined" && em instanceof EventTarget) {
    mode = "et";
    addl = "addEventListener";
    reml = "removeEventListener";
  } else if (typeof EventEmitter != "undefined" && em instanceof EventEmitter) {
    mode = "ee";
    addl = "on";
    reml = "off";
  }

  let enames = {};
  let anames = ev_name.split(/(\s+)/);
  for (let n in anames) {
    enames[anames[n]] = false;
  }

  if (ev_name == "*" && mode == "et") {
    for (let key in em) {
      if (!/^on/.test(key)) continue;
      let en = key.substr(2);
      enames[n] = false;
    }
  }
  if (ev_name == "*" && !em._catchall_done && mode == "ee") {
    em._catchall_done = true;
    em._emit_orig = em.emit;
    em.emit = function (name, ...args) {
      if (!enames[name]) {
        em.on(name, ecb);
        enames[name] = true;
      }
      em._emit_orig(name, ...args);
    };
  }

  //console.log(enames)
  //console.log(mode)
  //console.log(addl)
  //console.log(reml)
  for (let key in enames) {
    enames[key] = true;
    em[addl](key, ecb);
  }
  try {
    while (1) {
      yield await ep;
    }
  } finally {
    for (let key in enames) {
      em[reml](key, ecb);
    }
  }
}

async function on_first(em, ev_name) {
  let ret = await on(em, ev_name).next();
  return ret.value;
}

async function* race(ems) {
  while (1) {
    let proms = ems.map((x) => x.next());
    yield await Promise.race(proms);
  }
}

//-----------------------------------------------------------------------------------------

function md5(str) {
  let ret = crypto.createHash("md5").update(str).digest("hex");
  return ret;
}

function base64_encode(...args) {
  let ui8arr = new Uint8Array(...args);
  let ret = btoa(String.fromCharCode(...ui8arr));
  return ret;
}
function base64_decode(b64str) {
  let bytes = atob(b64str);
  let ret = Uint8Array.from(bytes, (c) => c.charCodeAt(0));
  return ret;
}

async function hash_hmac(hash_algo, msg, secret) {
  //hash_algo = "SHA-256"
  let enc = new TextEncoder("utf-8");
  let algo = { name: "HMAC", hash: hash_algo };
  let key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    algo,
    true,
    ["sign"],
  );
  let signature = await crypto.subtle.sign(algo.name, key, enc.encode(msg));
  //let digest = btoa(String.fromCharCode(...new Uint8Array(signature)))
  let digest = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return digest;
}

//-----------------------------------------------------------------------------------------

function str_kv(msg) {
  //remove emoj
  let kv = {};
  if (!msg) return;
  msg = msg.replace(/[^\p{L}\p{N}\p{P}\p{Z}^$\n]/gu, "");
  let m = Array.from(msg.matchAll(/^([^:\n]+):([^\n]+)/gm));
  for (let me of m) {
    kv[me[1].trim()] = me[2].trim();
  }
  return kv;
}

function remap_keys(m, o) {
  let r = {};
  for (let k of Object.keys(o)) {
    r[m?.[k] || k] = o[k];
  }
  return r;
}

//-----------------------------------------------------------------------------------------

function json_parse(s, merge) {
  let ret;
  try {
    ret = JSON.parse(s);
  } catch {}
  if (merge) ret = { ...merge, ...ret };
  return ret;
}

function json_parse_file(path, merge) {
  let str = null;
  try {
    str = fs.readFileSync(path).toString();
  } catch {}
  return json_parse(str, merge);
}

function objmap_parse_file(path, merge, blcase = true) {
  let ret;
  let str = null;
  try {
    str = fs.readFileSync(path).toString();
  } catch {}
  if (merge) ret = { ...merge, ...ret };
  let m = Array.from(str.matchAll(/\s*([^\n\r]+)\s*/gm));
  for (let i in m) {
    let l = m[i];
    let k = l[1];
    if (blcase) k = k.toLowerCase();
    //console.log(l)
    ret[k] = true;
  }
  return ret;
}

function json_write_file(path, o) {
  let s = JSON.stringify(o, null, 2);
  return fs.writeFileSync(path, s);
}

function conf_parse(cfg_str, default_key) {
  const cfg = {};
  const regex = new RegExp(
    r`^\s*(?<rem>#)?\s*(?<k>[^=$]*?)(?:\s*=\s*(?<v>[^$]*?)\s*)?$`,
    "gim",
  );
  const matches = cfg_str.matchAll(regex);

  for (const match of matches) {
    const comment = match.groups.rem;
    let key = match.groups.k;
    let value = match.groups.v;
    //console.log(match.groups)

    if (comment) continue;
    if (!key && !value) continue;

    if (!value && key) {
      value = key;
      key = default_key;
    }

    if (typeof cfg[key] != "undefined") {
      if (Array.isArray(cfg[key])) {
        cfg[key].push(value);
      } else {
        cfg[key] = [cfg[key], value];
      }
    } else {
      cfg[key] = value;
    }
  }

  return cfg;
}

function conf_parse_file(path, merge) {
  let str = null;
  try {
    str = fs.readFileSync(path).toString();
  } catch {}
  return conf_parse(str, merge);
}

//-----------------------------------------------------------------------------------------

function date_to_local(dt) {
  if (!dt) dt = new Date();
  let ret = new Date(dt.getTime() - new Date().getTimezoneOffset() * 60000);
  //ret = ret.toISOString()
  return ret;
}

function diff_minutes(dt2, dt1) {
  // Calculate the difference in milliseconds between the two provided dates and convert it to seconds
  var diff = (dt2.getTime() - dt1.getTime()) / 1000;
  // Convert the difference from seconds to minutes
  diff /= 60;
  // Return the absolute value of the rounded difference in minutes
  return Math.abs(Math.round(diff));
}

//-----------------------------------------------------------------------------------------

class pool {
  constructor() {
    this.workers_p = [];
  }
  async add(p) {
    if (p instanceof Function) p = p();
    this.workers_p.push(p);
    return await p;
  }
  async wait() {
    while (1) {
      //console.log('wait')
      this.results = await Promise.allSettled(this.workers_p);
      if (this.results.length >= this.workers_p.length) break;
    }
  }
}

//-----------------------------------------------------------------------------------------

let x = {
  clone,
  empty,
  sleep,
  on,
  on_first,
  race,
  base64_encode,
  base64_decode,
  md5,
  hash_hmac,
  str_kv,
  date_to_local,
  diff_minutes,
  conf_parse,
  conf_parse_file,
  json_parse,
  json_parse_file,
  json_write_file,
  remap_keys,
  sc,
  rand,
  object_sort,
  object_first,
  array_unique,
  objmap_parse_file,
  dfs,
  $,
  //pool,
};

export default x;

/*
// AutoVivification Proxy
function AV(root) {
  if(!root) root = {}
  let av = {
    root: root
  }
  av.px_handler = {
    //root: root,
    path: [],
    get(obj, prop, receiver) {
      //console.log('get',obj,prop)
      if(prop == 'toJSON') {
        //console.log('get toJSON nostring',arguments)
        throw "NO3"
        //return () => root
      }
      if(typeof prop != 'string') {
        //console.log('get nostring',arguments)
        //return Reflect.get(root,prop,root)
        throw "NO1"
      }
      let ret = av.proxy
      this.path.push(prop)
      if(prop == '$') {
        this.path.pop()
        //console.log(this.path)
        let r = av.root
        let plen = this.path.length
        let ik = 0
        while(1) {
          let k = this.path[ik]
          let k_is_last = ++ik >= plen
          //console.log(ik,k,k_is_last,r)
          if(k_is_last) {
            break
          }
          r = r?.[k]
        }
        ret = r
        this.path = []
      }
      return ret
    },
    set(obj, prop, value) {
      this.path.push(prop)
      //console.log('set',obj,prop,'$$')
      if(prop != '$' && prop != '$$') {
        throw "NO2"
        //return false
      }
      if(prop == '$' || prop == '$$') {
        this.path.pop()
        let is_append = prop == '$$'
        //console.log('set',this.path)
        let r = av.root
        let plen = this.path.length
        let ik = 0
        while(1) {
          let k = this.path[ik]
          let nk = this.path?.[ik+1]
          let k_is_last = ++ik >= plen
          //console.log(k,ik+1,this.path.length,k_is_last)
          if(is_append && k_is_last) {
            r[k] = []
          }
          if(k_is_last) {
            if(is_append) r[k].push(value)
            else r[k] = value
            if(av.onchange) av.onchange('set', value, av.root, this.path, is_append)
            break
          }
          let nk_array = !isNaN(parseInt(nk))
          let is_cnt = Array.isArray(r?.[k]) || typeof r?.[k] == 'object'
          if(!is_cnt) {
            r[k] = nk_array?[]:{}
          }
          r = r[k]
        }
        this.path = []
      }
      return true
    },
    deleteProperty(obj, prop) {
      this.path.push(prop)
      let r = av.root
      let plen = this.path.length
      let ik = 0
      while(1) {
        let k = this.path[ik]
        let k_is_last = ++ik >= plen
        //console.log(ik,k,k_is_last,r)
        if(k_is_last) {
          delete r?.[k]
          if(av.onchange) av.onchange('delete', av.root, this.path)
          break
        }
        r = r?.[k]
      }
      this.path = []
      return true
    }
  }
  av.proxy = new Proxy(av.root,av.px_handler)
  return [av.proxy,av]
}
*/
