import { refresh, type RefreshRequest } from './refresh-worker.ts';

self.onmessage = (event: MessageEvent<RefreshRequest>) => {
  void refresh(event.data, (message) => self.postMessage(message));
};
