'use strict';

// stdout 是 UTF-8 文本流：一个 chunk 可能只包含半行，也可能包含多行。
class JsonLineDecoder {
  constructor({ onLine, onOverflow, maxLineChars = 64 * 1024 * 1024 }) {
    this.onLine = onLine;
    this.onOverflow = onOverflow;
    this.maxLineChars = maxLineChars;
    this.buffer = '';
    this.failed = false;
  }

  push(chunk) {
    if (this.failed) return;
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      if (newline > this.maxLineChars) return this.overflow();
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      if (this.failed) return;
    }
    if (this.buffer.length > this.maxLineChars) this.overflow();
  }

  overflow() {
    this.stop();
    this.onOverflow();
  }

  stop() {
    this.failed = true;
    this.buffer = '';
  }
}

module.exports = { JsonLineDecoder };
