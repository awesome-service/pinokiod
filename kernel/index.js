const fs = require('fs')
const {JSONPath} = require('jsonpath-plus');
const os = require("os")
const path = require('path')
const fastq = require('fastq')
const fetch = require('cross-fetch');
const system = require('systeminformation');
const portfinder = require('portfinder');
const Loader = require("./loader")
const Bin = require('./bin')
const Api = require("./api")
const Template = require('./template')
const Shells = require("./shells")
const Key = require("./key")
const Config = require("./pinokio.json")
const VARS = {
  pip: {
    install: {
      torch: require("./vars/pip/install/torch")
    }
  }
}
//const memwatch = require('@airbnb/node-memwatch');
class Kernel {
  //schema = ">=1.0.0"
  schema = ">=1.0.0"
  constructor(store) {
    this.fetch = fetch
    this.store = store
    this.arch = os.arch()
    this.platform = os.platform()
    this.key = new Key()
  }
  resumeprocess(uri) {
    let proc = this.procs[uri]
    if (proc && proc.resolve) {
      proc.resolve()
      this.procs[uri] = undefined
    }
  }
  local(...args) {
    // get local variables at path
    let v = this.memory.local[path.resolve(...args)]
    if (v) {
      return  v
    } else {
      return {}
    }
  }
  global(...args) {
    // get local variables at path
    let v = this.memory.global[path.resolve(...args)]
    if (v) {
      return  v
    } else {
      return {}
    }
  }
  running(...args) {
    return this.status(path.resolve(...args))
  }
  status(uri, cwd) {
    let id = this.api.filePath(uri, cwd)
    return this.api.running[id]
  }
  port() {
    /**********************************************
    *
    *  let available_port = await kernel.port()
    *
    **********************************************/
    return portfinder.getPortPromise()
  }
  path(...args) {
    return path.resolve(this.homedir, ...args)
  }
  exists(...args) {
    let abspath = this.path(...args)
    return new Promise(r=>fs.access(abspath, fs.constants.F_OK, e => r(!e)))
  }
  async load(...filepath) {
    let p = path.resolve(...filepath)
    let json = (await this.loader.load(p)).resolved
    return json
  }
  async require(...filepath) {
    let p = path.resolve(...filepath)
    let json = (await this.loader.load(p)).resolved
    return json
  }
  log(data, group, info) {
    this.log_queue.push({ data, group, info })
  }
  async clearLog(group) {
    let relativePath = path.relative(this.homedir, group)
    for(let type of ["info", "buf", "cleaned"]) {
      let logPath = path.resolve(this.homedir, "logs", "shell", type, relativePath)
      let logFolder = path.dirname(logPath)
      let filename = path.basename(logPath)
      try {
        let files = await fs.promises.readdir(logFolder)
        for(let file of files) {
          if (file.startsWith(filename)) {
            let p = path.resolve(logFolder, file)
            await fs.promises.rm(p)
          }
        }
      } catch (e) {
        console.log(e)
      }
    }
  }
  async _log(data, group, info) {
    if (group) {

      // 1. prepare data
      let relativePath = path.relative(this.homedir, group)

      if (!path.isAbsolute(relativePath)) {
        for(let type of ["info", "buf", "cleaned"]) {
          let logPath = path.resolve(this.homedir, "logs", "shell", type, relativePath + "." + info.index + ".yaml")
          let logFolder = path.dirname(logPath)
          await fs.promises.mkdir(logFolder, { recursive: true }).catch((e) => { })
          await fs.promises.appendFile(logPath, data[type])
        }
      }
    } else {
      for(let type of ["info", "buf", "cleaned"]) {
        let logPath = path.resolve(this.homedir, "logs", "shell", type, "index.yaml")
        let logFolder = path.dirname(logPath)
        await fs.promises.mkdir(logFolder, { recursive: true }).catch((e) => { })
        await fs.promises.appendFile(logPath, data[type])
      }
    }
  }


  async init() {
    let home = this.store.get("home")

    this.homedir = home

    console.log("kernel.init", { homedir: this.homedir })

//    if (home) {
//      this.homedir = home
//    } else {
//      this.homedir = path.resolve(os.homedir(), "pinokio")
//    }
    console.log("homedir", this.homedir)
    if (this.log_queue) {
      this.log_queue.killAndDrain()
    }
    this.log_queue = fastq.promise(async ({ data, group, info }) => {
      await this._log(data, group, info)
    }, 1)

    this.vars = {}
    for(let type in VARS) {
      let actions = VARS[type]
      if (!this.vars[type]) this.vars[type] = {}
      for(let action in actions) {
        if (!this.vars[type][action]) this.vars[type][action] = {}
        let Mods = actions[action]
        for(let modname in Mods) {
          if (!this.vars[type][action][modname]) this.vars[type][action][modname] = {}
          let mod = new Mods[modname]()
          this.vars[type][action][modname] = await mod.init()
        }
      }
    }
    console.log("this.vars", this.vars)

//    let keyfile = path.resolve(this.homedir, "keys.json")
//    await this.key.init(keyfile)

//    let home = this.store.get("home")
//    if (home) {
//      this.homedir = home
//    } else {
//      this.homedir = path.resolve(os.homedir(), "pinokio")
//    }
//    console.log("homedir", this.homedir)
    this.loader = new Loader()
    this.bin = new Bin(this)
    this.api = new Api(this)
    this.shell = new Shells(this)
    this.system = system
    this.keys = {}
    this.memory = {
      local: {},
      global: {},
      key: (host) => {
        return this.keys[host]
      }
    }
    this.procs = {}
    this.template = new Template(this)
    try {
      if (this.homedir) {
        await fs.promises.mkdir(this.homedir, { recursive: true }).catch((e) => {})
        const cache_folders = [
          "HF_HOME",
          "TORCH_HOME",
          "HOMEBREW_CACHE",
          "XDG_CACHE_HOME",
          "PIP_CACHE_DIR",
          "PIP_TMPDIR",
          "TEMP",
          "TMP",
          "XDG_DATA_HOME",
          "XDG_CONFIG_HOME",
          "XDG_STATE_HOME",
          "GRADIO_TEMP_DIR"
        ]
        for(let folder of cache_folders) {
          await fs.promises.mkdir(path.resolve(this.homedir, "cache", folder), { recursive: true }).catch((e) => {})
        }

      }

//      let contents = await fs.promises.readdir(this.homedir)
      await this.bin.init()
      await this.api.init()
      await this.template.init()

      this.gpu = this.template.gpu
      this.gpus = this.template.gpus

//      let PuppeteerPath = this.bin.path("puppet", "node_modules", "puppeteer")
//      this.puppet = (await this.loader.load(PuppeteerPath)).resolved
//      this.puppet.setGlobalOptions({
//        userDataDir: this.bin.path("puppet")
//      });

    } catch (e) {
      console.log("### ERROR", e)
    }
  }
  async exec(params, ondata) {
//    params.path = this.path()
//    if (this.client) {
//      params.cols = this.client.cols
//      params.rows = this.client.rows
//    }
    let response = await this.shell.run(params, null, ondata)
    return response
  }
}
module.exports = Kernel
