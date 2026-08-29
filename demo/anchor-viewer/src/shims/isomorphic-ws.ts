// The indexer provider imports a *named* WebSocket from isomorphic-ws, whose
// browser build only sets a default export. Browsers have WebSocket natively,
// so this alias supplies both shapes rather than pulling in a polyfill.
const WS = globalThis.WebSocket;
export { WS as WebSocket };
export default WS;
