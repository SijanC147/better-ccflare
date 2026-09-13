import { EventEmitter } from "node:events";

// Event emitter for log streaming.
//
// Its own module so the OpenObserve exporter can subscribe without importing
// the package index, which would import the exporter back.
export const logBus = new EventEmitter();

// Set a more generous max listeners limit for SSE connections
// This allows for more concurrent SSE connections while still providing protection
logBus.setMaxListeners(200);
