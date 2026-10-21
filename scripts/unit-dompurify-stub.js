// DOMPurify passthrough for the node unit bundle: sanitize cannot run
// without a DOM, and the unit tests assert the marked pipeline's output.
// The browser bundle keeps the real thing.
module.exports = {
  isSupported: false,
  sanitize: (html) => html,
};
