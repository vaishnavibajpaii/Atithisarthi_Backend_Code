"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const storage = new AsyncLocalStorage();
module.exports = {
  run(context, work) { return storage.run(Object.freeze({ ...context }), work); },
  get() { return storage.getStore() || {}; }
};
