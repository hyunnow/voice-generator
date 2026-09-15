// Imported before kokoro-js. WebKit (Safari and every iOS browser) can't `for await` over a ReadableStream,
// which the espeak-ng phonemizer bundled in kokoro-js does while unpacking its data, failing with
// "undefined is not a function (near '...e of A...')".
if (!ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}
