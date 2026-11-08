<script lang="ts">
  export type JijiState = "idle" | "listening" | "thinking" | "analyzing" | "done" | "error" | "sleeping";

  let {
    state = "idle",
    size = 72,
    interactive = false,
    oninteract,
  }: {
    state?: JijiState;
    size?: number;
    interactive?: boolean;
    oninteract?: () => void;
  } = $props();

  const labels: Record<JijiState, string> = {
    idle: "吉吉正在待机",
    listening: "吉吉正在倾听",
    thinking: "吉吉正在思考",
    analyzing: "吉吉正在分析",
    done: "吉吉完成了",
    error: "吉吉遇到问题",
    sleeping: "吉吉睡着了",
  };
</script>

<svelte:element
  this={interactive ? "button" : "span"}
  type={interactive ? "button" : undefined}
  class="jiji"
  class:interactive
  data-state={state}
  aria-label={interactive ? `${labels[state]}，点一下摸摸它` : labels[state]}
  role={interactive ? undefined : "img"}
  style={`--jiji-size:${size}px`}
  onclick={interactive ? oninteract : undefined}
>
  <svg viewBox="0 0 160 160" aria-hidden="true">
    <g class="tail">
      <path class="tail-rim" d="M108 130C139 132 149 112 138 91C132 79 121 76 125 64" />
      <path class="tail-line" d="M108 130C139 132 149 112 138 91C132 79 121 76 125 64" />
    </g>

    <g class="cat">
      <ellipse class="shadow" cx="80" cy="143" rx="44" ry="7" />
      <path class="body" d="M48 140C46 111 54 91 69 82H91C106 91 114 111 112 140Z" />
      <g class="head">
        <path class="ear ear-left" d="M47 62L51 24Q52 18 58 22L75 38Z" />
        <path class="ear ear-right" d="M113 62L109 24Q108 18 102 22L85 38Z" />
        <rect class="face" x="45" y="38" width="70" height="62" rx="27" />

        <g class="eyes eyes-open">
          <ellipse class="eye" cx="67" cy="68" rx="10" ry="11" />
          <ellipse class="eye" cx="93" cy="68" rx="10" ry="11" />
          <ellipse class="pupil pupil-left" cx="67" cy="69" rx="2.8" ry="7" />
          <ellipse class="pupil pupil-right" cx="93" cy="69" rx="2.8" ry="7" />
        </g>
        <g class="eyes eyes-happy">
          <path d="M57 72Q67 59 77 72" />
          <path d="M83 72Q93 59 103 72" />
        </g>
        <g class="eyes eyes-sleepy">
          <path d="M57 68Q67 75 77 68" />
          <path d="M83 68Q93 75 103 68" />
        </g>
        <path class="mouth" d="M75 83Q80 87 85 83" />
      </g>

      <g class="paw paw-left"><rect x="56" y="124" width="18" height="19" rx="9" /></g>
      <g class="paw paw-right"><rect x="86" y="124" width="18" height="19" rx="9" /></g>
    </g>

    <g class="cells">
      <rect x="17" y="130" width="13" height="13" rx="3" />
      <rect x="33" y="130" width="13" height="13" rx="3" />
      <rect x="17" y="114" width="13" height="13" rx="3" />
      <rect x="33" y="114" width="13" height="13" rx="3" />
    </g>

    <g class="sleep-z">
      <text x="116" y="52">z</text>
      <text x="132" y="34">z</text>
    </g>
  </svg>
</svelte:element>

<style>
  .jiji {
    display: inline-grid;
    width: var(--jiji-size);
    height: var(--jiji-size);
    flex: 0 0 auto;
    place-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
  }

  .interactive {
    cursor: pointer;
  }

  .interactive:focus-visible {
    border-radius: 12px;
    outline: 2px solid #f5c542;
    outline-offset: 2px;
  }

  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .cat,
  .body,
  .head,
  .ear,
  .tail,
  .paw,
  .eyes,
  .pupil {
    transform-box: fill-box;
    transform-origin: center;
  }

  .body,
  .face,
  .ear,
  .paw rect {
    fill: #161513;
  }

  .shadow {
    fill: #161513;
    opacity: .1;
  }

  .tail-rim,
  .tail-line,
  .mouth,
  .eyes-happy path,
  .eyes-sleepy path {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .tail-rim {
    stroke: #f6f1e7;
    stroke-width: 12;
  }

  .tail-line {
    stroke: #161513;
    stroke-width: 8;
  }

  .eye,
  .cells rect {
    fill: #f5c542;
  }

  .pupil {
    fill: #161513;
  }

  .mouth,
  .eyes-happy path,
  .eyes-sleepy path {
    stroke: #f5c542;
    stroke-width: 3;
  }

  .eyes-happy,
  .eyes-sleepy,
  .cells,
  .sleep-z {
    opacity: 0;
  }

  .sleep-z {
    fill: #756f63;
    font: 700 16px var(--font-sans);
  }

  [data-state="idle"] .body {
    animation: breathe 2.8s ease-in-out infinite;
  }

  [data-state="idle"] .tail {
    animation: tail-slow 2.5s ease-in-out infinite alternate;
    transform-origin: 15% 85%;
  }

  [data-state="idle"] .eyes-open {
    animation: blink 5.2s ease-in-out infinite;
  }

  [data-state="listening"] .head {
    transform: rotate(-8deg);
  }

  [data-state="listening"] .ear-left {
    transform: rotate(7deg) scaleY(1.1);
  }

  [data-state="listening"] .ear-right {
    transform: rotate(-7deg) scaleY(1.1);
  }

  [data-state="listening"] .pupil {
    transform: scaleX(2);
  }

  [data-state="thinking"] .pupil {
    animation: think-look 1.1s ease-in-out infinite alternate;
    transform: scaleX(.65);
  }

  [data-state="thinking"] .tail {
    animation: tail-fast .48s ease-in-out infinite alternate;
    transform-origin: 15% 85%;
  }

  [data-state="analyzing"] .cells {
    opacity: 1;
  }

  [data-state="analyzing"] .cells rect {
    animation: cell-light 1.2s ease-in-out infinite;
  }

  [data-state="analyzing"] .cells rect:nth-child(2) { animation-delay: .2s; }
  [data-state="analyzing"] .cells rect:nth-child(3) { animation-delay: .4s; }
  [data-state="analyzing"] .cells rect:nth-child(4) { animation-delay: .6s; }

  [data-state="analyzing"] .paw-left {
    animation: paw-tap .6s ease-in-out infinite alternate;
  }

  [data-state="done"] .eyes-open,
  [data-state="sleeping"] .eyes-open {
    opacity: 0;
  }

  [data-state="done"] .eyes-happy {
    opacity: 1;
  }

  [data-state="done"] .cat {
    animation: done-hop .7s ease-out both;
  }

  [data-state="done"] .tail {
    transform: rotate(-20deg);
  }

  [data-state="error"] .cat {
    animation: error-shake .45s linear 2;
  }

  [data-state="error"] .ear-left {
    transform: rotate(-26deg) scaleY(.82);
  }

  [data-state="error"] .ear-right {
    transform: rotate(26deg) scaleY(.82);
  }

  [data-state="error"] .tail-line {
    stroke-width: 13;
  }

  [data-state="sleeping"] .eyes-sleepy,
  [data-state="sleeping"] .sleep-z {
    opacity: 1;
  }

  [data-state="sleeping"] .head {
    animation: sleep-head 2.8s ease-in-out infinite;
    transform: translateY(7px) rotate(-7deg);
  }

  [data-state="sleeping"] .body {
    animation: breathe 2.8s ease-in-out infinite;
  }

  [data-state="sleeping"] .sleep-z text {
    animation: z-float 2.8s ease-out infinite;
  }

  [data-state="sleeping"] .sleep-z text:nth-child(2) {
    animation-delay: 1.4s;
  }

  @keyframes breathe {
    from { transform: scaleY(1); }
    50% { transform: scaleY(1.025); }
    to { transform: scaleY(1); }
  }

  @keyframes tail-slow {
    from { transform: rotate(-7deg); }
    to { transform: rotate(7deg); }
  }

  @keyframes tail-fast {
    from { transform: rotate(-5deg); }
    to { transform: rotate(7deg); }
  }

  @keyframes blink {
    0%, 45%, 49%, 100% { transform: scaleY(1); }
    47% { transform: scaleY(.08); }
  }

  @keyframes think-look {
    from { transform: translateX(-4px) scaleX(.65); }
    to { transform: translateX(4px) scaleX(.65); }
  }

  @keyframes paw-tap {
    from { transform: translate(0, 0); }
    to { transform: translate(-13px, -7px); }
  }

  @keyframes cell-light {
    0%, 100% { opacity: .22; }
    50% { opacity: 1; }
  }

  @keyframes done-hop {
    0% { transform: translateY(0); }
    35% { transform: translateY(-9px); }
    100% { transform: translateY(0); }
  }

  @keyframes error-shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    75% { transform: translateX(4px); }
  }

  @keyframes sleep-head {
    0%, 100% { transform: translateY(7px) rotate(-7deg); }
    50% { transform: translateY(9px) rotate(-7deg); }
  }

  @keyframes z-float {
    0% { opacity: 0; transform: translateY(4px); }
    25%, 65% { opacity: 1; }
    100% { opacity: 0; transform: translateY(-12px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .jiji :global(*) {
      animation-duration: .001ms !important;
      animation-iteration-count: 1 !important;
    }
  }
</style>
