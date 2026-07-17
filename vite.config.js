import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        tilt: resolve(__dirname, "tilt.html"),
        bubbles: resolve(__dirname, "bubbles.html"),
        gallery: resolve(__dirname, "gallery.html"),
      },
    },
  },
});
