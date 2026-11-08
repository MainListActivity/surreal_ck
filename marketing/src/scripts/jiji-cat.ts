import { gsap } from "gsap";
import type { JijiState } from "../data/jiji";

type EyeMode = "open" | "happy" | "sleepy";

type Pose = {
  headRotation: number;
  headY: number;
  earLeftRotation: number;
  earRightRotation: number;
  earScaleY: number;
  tailRotation: number;
  tailWidth: number;
  pupilRx: number;
  gazeX: number;
  gazeY: number;
  eyes: EyeMode;
  cells: boolean;
};

export type JijiController = {
  readonly state: JijiState;
  setState(state: JijiState): void;
  pet(): void;
  destroy(): void;
};

const basePose: Pose = {
  headRotation: 0,
  headY: 0,
  earLeftRotation: 0,
  earRightRotation: 0,
  earScaleY: 1,
  tailRotation: 0,
  tailWidth: 13,
  pupilRx: 3.2,
  gazeX: 0,
  gazeY: 0,
  eyes: "open",
  cells: false,
};

const poses: Record<JijiState, Pose> = {
  idle: basePose,
  listening: { ...basePose, headRotation: -9, earLeftRotation: 7, earRightRotation: -7, earScaleY: 1.12, pupilRx: 6.5 },
  thinking: { ...basePose, headRotation: 5, pupilRx: 2, tailRotation: -6 },
  analyzing: { ...basePose, headRotation: -6, pupilRx: 4, gazeX: -5, gazeY: 4, cells: true },
  done: { ...basePose, eyes: "happy", tailRotation: -26, earScaleY: 1.06 },
  error: { ...basePose, earLeftRotation: -32, earRightRotation: 32, earScaleY: .82, pupilRx: 1.6, tailWidth: 21 },
  sleeping: { ...basePose, eyes: "sleepy", headY: 15, headRotation: -8, earLeftRotation: -12, earRightRotation: 12, tailRotation: 38 },
};

const followStates = new Set<JijiState>(["idle", "listening"]);
const blinkStates = new Set<JijiState>(["idle", "listening", "thinking", "analyzing"]);

function part<T extends Element>(root: Element, name: string): T {
  const element = root.querySelector<T>(`[data-part="${name}"]`);
  if (!element) throw new Error(`吉吉缺少部件：${name}`);
  return element;
}

function parts<T extends Element>(root: Element, name: string): T[] {
  return Array.from(root.querySelectorAll<T>(`[data-part="${name}"]`));
}

export function createJiji(root: SVGSVGElement, options: { reducedMotion: boolean }): JijiController {
  const cat = part<SVGGElement>(root, "cat");
  const head = part<SVGGElement>(root, "head");
  const earLeft = part<SVGPathElement>(root, "ear-left");
  const earRight = part<SVGPathElement>(root, "ear-right");
  const tail = part<SVGGElement>(root, "tail");
  const tailStroke = part<SVGPathElement>(root, "tail-stroke");
  const body = part<SVGGElement>(root, "body");
  const pawLeft = part<SVGGElement>(root, "paw-left");
  const pawRight = part<SVGGElement>(root, "paw-right");
  const eyesOpen = part<SVGGElement>(root, "eyes-open");
  const eyesHappy = part<SVGGElement>(root, "eyes-happy");
  const eyesSleepy = part<SVGGElement>(root, "eyes-sleepy");
  const cellsGroup = part<SVGGElement>(root, "cells");
  const eyes = parts<SVGGElement>(root, "eye");
  const gaze = parts<SVGGElement>(root, "gaze");
  const pupils = parts<SVGEllipseElement>(root, "pupil");
  const cells = parts<SVGRectElement>(root, "cell");
  const zs = parts<SVGTextElement>(root, "z");

  gsap.set(cat, { svgOrigin: "120 220" });
  gsap.set(head, { svgOrigin: "120 136" });
  gsap.set(earLeft, { svgOrigin: "93 84" });
  gsap.set(earRight, { svgOrigin: "147 84" });
  gsap.set(tail, { svgOrigin: "158 204" });
  gsap.set(body, { svgOrigin: "120 217" });
  gsap.set(eyes, { transformOrigin: "50% 50%" });

  const reduced = options.reducedMotion;
  const gazeX = gsap.quickTo(gaze, "x", { duration: .4, ease: "power3.out" });
  const gazeY = gsap.quickTo(gaze, "y", { duration: .4, ease: "power3.out" });
  let state: JijiState = "idle";
  let loop: gsap.core.Timeline | null = null;
  let blinkCall: gsap.core.Tween | null = null;

  const eyeOpacity = (mode: EyeMode): [number, number, number] => [
    mode === "open" ? 1 : 0,
    mode === "happy" ? 1 : 0,
    mode === "sleepy" ? 1 : 0,
  ];

  const applyPose = (pose: Pose, duration: number): void => {
    const shared = { duration, ease: "power3.out", overwrite: "auto" as const };
    const [open, happy, sleepy] = eyeOpacity(pose.eyes);
    gsap.to(cat, { ...shared, x: 0, y: 0, rotation: 0 });
    gsap.to(head, { ...shared, rotation: pose.headRotation, y: pose.headY });
    gsap.to(earLeft, { ...shared, rotation: pose.earLeftRotation, scaleY: pose.earScaleY });
    gsap.to(earRight, { ...shared, rotation: pose.earRightRotation, scaleY: pose.earScaleY });
    gsap.to(tail, { ...shared, rotation: pose.tailRotation });
    gsap.to(tailStroke, { ...shared, attr: { "stroke-width": pose.tailWidth } });
    gsap.to(body, { ...shared, scaleX: 1, scaleY: 1 });
    gsap.to([pawLeft, pawRight], { ...shared, x: 0, y: 0 });
    gsap.to(pupils, { ...shared, attr: { rx: pose.pupilRx } });
    gsap.to(eyes, { ...shared, scaleY: 1 });
    gsap.to(eyesOpen, { ...shared, opacity: open });
    gsap.to(eyesHappy, { ...shared, opacity: happy });
    gsap.to(eyesSleepy, { ...shared, opacity: sleepy });
    gsap.to(cellsGroup, { ...shared, opacity: pose.cells ? 1 : 0 });
    gsap.to(cells, { ...shared, attr: { "fill-opacity": 0 } });
    gsap.to(zs, { ...shared, opacity: 0, y: 0 });
    gazeX(pose.gazeX);
    gazeY(pose.gazeY);
  };

  const buildLoop = (next: JijiState, delay: number): gsap.core.Timeline | null => {
    if (reduced) return null;
    const pose = poses[next];
    const tl = gsap.timeline({ delay });

    switch (next) {
      case "idle":
        tl.to(tail, { rotation: -10, duration: 2.2, ease: "sine.inOut", repeat: -1, yoyo: true }, 0)
          .to(body, { scaleY: 1.02, duration: 2.2, ease: "sine.inOut", repeat: -1, yoyo: true }, 0);
        break;
      case "listening":
        tl.to(tail, { rotation: 6, duration: 1.1, ease: "sine.inOut", repeat: -1, yoyo: true }, 0)
          .to(head, { rotation: pose.headRotation - 3, duration: 1.8, ease: "sine.inOut", repeat: -1, yoyo: true }, 0);
        break;
      case "thinking":
        tl.to(gaze, { x: 5, duration: .55, ease: "sine.inOut", repeat: -1, yoyo: true, repeatDelay: .25 }, 0)
          .fromTo(tail, { rotation: -6 }, { rotation: 4, duration: .45, ease: "sine.inOut", repeat: -1, yoyo: true }, 0);
        break;
      case "analyzing": {
        const taps = gsap.timeline({ repeat: -1, repeatDelay: .3 });
        cells.forEach((cell, index) => {
          taps.to(pawLeft, { x: -10 - index * 6, y: -12, duration: .16, ease: "power2.out" })
            .to(pawLeft, { y: 0, duration: .14, ease: "power2.in" })
            .to(cell, { attr: { "fill-opacity": 1 }, duration: .12 }, "<");
        });
        taps.to(pawLeft, { x: 0, duration: .25 })
          .to(cells, { attr: { "fill-opacity": 0 }, duration: .25 }, "<");
        tl.add(taps, 0)
          .to(tail, { rotation: 5, duration: .9, ease: "sine.inOut", repeat: -1, yoyo: true }, 0);
        break;
      }
      case "done":
        tl.to(cat, { y: -14, duration: .22, ease: "power2.out" }, 0)
          .to(cat, { y: 0, duration: .5, ease: "bounce.out" })
          .to(tail, { rotation: -18, duration: .5, ease: "sine.inOut", repeat: -1, yoyo: true });
        break;
      case "error":
        tl.to(cat, { keyframes: { x: [-7, 7, -5, 5, -2, 0] }, duration: .5, ease: "none" }, 0)
          .to(tail, { rotation: 4, duration: .07, repeat: 9, yoyo: true, ease: "none" }, 0)
          .to(tailStroke, { attr: { "stroke-width": 15 }, duration: .8, ease: "power2.out" }, .7);
        break;
      case "sleeping":
        tl.to(body, { scaleY: 1.035, scaleX: .99, duration: 2.6, ease: "sine.inOut", repeat: -1, yoyo: true }, 0)
          .to(head, { y: pose.headY + 2, duration: 2.6, ease: "sine.inOut", repeat: -1, yoyo: true }, 0);
        zs.forEach((z, index) => {
          tl.fromTo(
            z,
            { opacity: 0, y: 0 },
            { keyframes: { opacity: [0, 1, 1, 0], y: [0, -8, -14, -22] }, duration: 2.8, ease: "none", repeat: -1, delay: index * 1.4 },
            0,
          );
        });
        break;
    }

    return tl;
  };

  const scheduleBlink = (): void => {
    if (reduced) return;
    blinkCall = gsap.delayedCall(gsap.utils.random(2.2, 5.5), () => {
      if (blinkStates.has(state)) {
        gsap.to(eyes, { scaleY: .08, duration: .08, ease: "power1.in", yoyo: true, repeat: 1 });
      }
      scheduleBlink();
    });
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (reduced || !followStates.has(state)) return;
    const rect = root.getBoundingClientRect();
    const dx = (event.clientX - (rect.left + rect.width / 2)) / Math.max(rect.width, 1);
    const dy = (event.clientY - (rect.top + rect.height * .42)) / Math.max(rect.height, 1);
    gazeX(gsap.utils.clamp(-5, 5, dx * 9));
    gazeY(gsap.utils.clamp(-4, 4, dy * 8));
  };

  const setState = (next: JijiState): void => {
    const previous = state;
    state = next;
    loop?.kill();
    loop = null;

    const duration = reduced ? 0 : .45;
    applyPose(poses[next], duration);

    let delay = duration;
    if (previous === "sleeping" && next !== "sleeping" && !reduced) {
      // 从睡眠醒来时先伸个懒腰，再进入目标状态的循环动作。
      gsap.timeline()
        .to(body, { scaleY: .9, scaleX: 1.07, duration: .35, ease: "power2.out" })
        .to(body, { scaleY: 1, scaleX: 1, duration: .55, ease: "elastic.out(1, .5)" });
      delay = .9;
    }
    loop = buildLoop(next, delay);
  };

  const pet = (): void => {
    if (reduced || state === "sleeping") return;
    const [open, happy] = eyeOpacity(poses[state].eyes);
    gsap.timeline()
      .to(eyesOpen, { opacity: 0, duration: .12 }, 0)
      .to(eyesHappy, { opacity: 1, duration: .12 }, 0)
      .to(cat, { keyframes: { rotation: [-2.5, 2.5, -2, 2, -1, 0] }, duration: .7, ease: "none" }, 0)
      .to(eyesOpen, { opacity: open, duration: .2 }, 1.1)
      .to(eyesHappy, { opacity: happy, duration: .2 }, 1.1);
  };

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  setState("idle");
  scheduleBlink();

  return {
    get state() {
      return state;
    },
    setState,
    pet,
    destroy() {
      loop?.kill();
      blinkCall?.kill();
      window.removeEventListener("pointermove", onPointerMove);
    },
  };
}
