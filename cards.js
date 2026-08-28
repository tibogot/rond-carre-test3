import gsap from "gsap";
import CustomEase from "gsap/CustomEase";

gsap.registerPlugin(CustomEase);
CustomEase.create("my-ease", "0.32, 0, 0.12, 1");
gsap.defaults({ ease: "my-ease" });

const DESKTOP_CARDS = [
  { width: 290, height: 380, x: -70, rotate: 5 },
  { width: 300, height: 400, x: -120, rotate: 10 },
  { width: 320, height: 440, x: 140, rotate: -10 },
  { width: 330, height: 460, x: -70, rotate: 6 },
  { width: 340, height: 480, x: 270, rotate: -20 },
  { width: 350, height: 500, x: 70, rotate: -5 },
  { width: 360, height: 520, x: -70, rotate: 5 },
  { width: 370, height: 540, x: -180, rotate: 10 },
];

const MOBILE_CARDS = [
  { width: 200, height: 220, x: -70, rotate: 5 },
  { width: 210, height: 230, x: -120, rotate: 10 },
  { width: 220, height: 440, x: 140, rotate: -10 },
  { width: 230, height: 360, x: -70, rotate: 6 },
  { width: 240, height: 380, x: 270, rotate: -20 },
  { width: 250, height: 400, x: 70, rotate: -5 },
  { width: 260, height: 420, x: -70, rotate: 5 },
  { width: 270, height: 440, x: -180, rotate: 10 },
];

const center = (outer, inner) => outer / 2 - inner / 2;

class ClipRect {
  constructor({ translateX, translateY, rotate, width, height }) {
    this.translateX = translateX;
    this.translateY = translateY;
    this.rotate = rotate;
    this.width = width;
    this.height = height;
  }

  convertToClipPathPolygon() {
    const { translateX: x, translateY: y, width, height } = this;
    const radians = (this.rotate * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    const corners = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ];

    const points = corners.map(([cornerX, cornerY]) => {
      const dx = cornerX - centerX;
      const dy = cornerY - centerY;
      const rotatedX = dx * cos - dy * sin + centerX;
      const rotatedY = dx * sin + dy * cos + centerY;
      return `${rotatedX}px ${rotatedY}px`;
    });

    return `polygon(${points.join(", ")})`;
  }
}

function buildStates() {
  const cards = window.innerWidth >= 768 ? DESKTOP_CARDS : MOBILE_CARDS;

  return cards.map((card) => ({
    from: {
      translateX: center(window.innerWidth, card.width) + card.x,
      translateY: window.innerHeight + card.height / 2,
      rotate: card.rotate,
      width: card.width,
      height: card.height,
    },
    to: {
      translateX: center(window.innerWidth, card.width),
      translateY: center(window.innerHeight, card.height),
      rotate: card.rotate,
      width: card.width,
      height: card.height,
    },
  }));
}

const polygon = (state) => new ClipRect(state).convertToClipPathPolygon();

function buildTimeline() {
  const states = buildStates();
  const items = document.querySelectorAll(".preloader__item");
  const replay = document.querySelector(".replay");

  const timeline = gsap.timeline({
    defaults: { ease: "none", duration: 0.5 },
    onStart() {
      document.querySelector(".page-alpfa").style.display = "none";
      replay.hidden = true;
    },
    onComplete() {
      replay.hidden = false;
    },
  });

  items.forEach((item, index) => {
    // "<25%" starts each card a quarter into the previous one, so the deck overlaps.
    timeline.fromTo(
      item,
      { clipPath: polygon(states[index].from) },
      { clipPath: polygon(states[index].to) },
      index ? "<25%" : 0
    );

    if (index !== items.length - 1) return;

    // The final card is a window onto the page itself, then it opens to full screen.
    timeline.fromTo(
      ".wrapper",
      { clipPath: polygon(states[index + 1].from) },
      { clipPath: polygon(states[index + 1].to) },
      "<25%"
    );

    timeline.to(".wrapper", {
      clipPath: `polygon(0px 0px, ${window.innerWidth}px 0px, ${window.innerWidth}px ${window.innerHeight}px, 0px ${window.innerHeight}px)`,
      clearProps: "all",
      ease: "my-ease",
      duration: 1,
    });

    timeline.from(
      ".main-bg",
      { scale: 1.2, ease: "my-ease", duration: 1 },
      "<"
    );
  });

  timeline.set(".preloader", { display: "none" });

  return timeline;
}

function preload(sources) {
  return Promise.all(
    sources.map(
      (src) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = resolve;
          image.onerror = resolve;
          image.src = src;
        })
    )
  );
}

let timeline;

function play() {
  timeline?.kill();
  gsap.set(".preloader", { display: "block" });
  gsap.set(".main-bg", { clearProps: "all" });
  timeline = buildTimeline();
}

const sources = [
  ...document.querySelectorAll(".preloader__item-img"),
  document.querySelector(".main-bg"),
].map((image) => image.getAttribute("src"));

preload(sources).then(play);

document.querySelector(".replay").addEventListener("click", play);
