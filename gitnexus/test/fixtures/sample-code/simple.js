const path = require('path');

class EventEmitter {
  constructor() {
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  emit(event, ...args) {
    const handlers = this.listeners[event] || [];
    handlers.forEach(handler => handler(...args));
  }
}

function createLogger(prefix) {
  return {
    log: (msg) => console.log(`[${prefix}] ${msg}`),
    error: (msg) => console.error(`[${prefix}] ${msg}`),
  };
}

const formatDate = (date) => {
  return date.toISOString().split('T')[0];
};

module.exports = { EventEmitter, createLogger, formatDate };
