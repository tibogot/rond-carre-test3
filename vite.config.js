import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        home2: resolve(__dirname, "home2.html"),
        tilt: resolve(__dirname, "tilt.html"),
        tilt2: resolve(__dirname, "tilt2.html"),
        bubbles: resolve(__dirname, "bubbles.html"),
        bubbles2: resolve(__dirname, "bubbles2.html"),
        rain: resolve(__dirname, "rain.html"),
        rain2: resolve(__dirname, "rain2.html"),
        gallery: resolve(__dirname, "gallery.html"),
      },
    },
  },
});
