/**
 * The application's entry point.
 *
 * There is no longer a hand-written page beside this — `index.html` is a
 * stylesheet and a mount point, and everything that behaves lives here. The
 * migration got here one container at a time, with the page shrinking by
 * exactly what each component took over, so the app was never half-built.
 */
import { createApp } from 'vue';
import App from './components/App.vue';

createApp(App).mount('#app');
