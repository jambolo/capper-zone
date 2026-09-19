import { greet } from './index.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
  app.textContent = greet('world');
}
