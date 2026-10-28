import './style.css';
import { App } from './app';

// URL options: ?vd=<2..16> view distance in chunks.

const root = document.getElementById('app')!;
const app = new App(root);
void app.start();
Object.assign(window, { cubica: app }); // handy for debugging in the console
