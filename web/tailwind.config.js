// Tailwind v3 on purpose: pure JavaScript, no native binary to fail on Termux.
// Colours are CSS variables (see src/index.css) so light and dark themes share one set of class names.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: v("paper"), surface: v("surface"), ink: v("ink"), line: v("line"),
        brand: v("brand"), onbrand: v("on-brand"), gold: v("gold"), hero: v("hero"),
        signal: v("signal"), caution: v("caution"), alarm: v("alarm"),
      },
      fontFamily: { sans: ['"Bricolage Grotesque"', "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
    },
  },
  plugins: [],
};
