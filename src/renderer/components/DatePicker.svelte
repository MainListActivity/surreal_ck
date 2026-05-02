<script lang="ts">
  import { onDestroy } from "svelte";
  import Icon from "./Icon.svelte";
  import {
    DEFAULT_DATE_FORMAT,
    dateFormatHasTime,
    formatDateValue,
    toDate,
  } from "../../shared/date-format";

  /**
   * 自建日期选择器：触发按钮 + 浮层月历 + 可选时分秒滚轮。
   *
   * - value: 当前日期，支持 Date / ISO 字符串 / null
   * - onChange: 用户选定/清空时回调；选定传 Date，清空传 null
   * - dateFormat: 显示格式（dayjs token），同时决定是否展示时间行
   * - minDate / maxDate: ISO 字符串边界，越界日期会灰显并禁用
   * - openOnMount: 单元格 editor 模式下挂载即弹出
   */
  let {
    value = null,
    onChange,
    onClose,
    dateFormat = DEFAULT_DATE_FORMAT,
    minDate,
    maxDate,
    disabled = false,
    placeholder = "选择日期",
    openOnMount = false,
    fullWidth = false,
    ariaLabel,
  }: {
    value?: Date | string | null;
    onChange: (next: Date | null) => void;
    onClose?: () => void;
    dateFormat?: string;
    minDate?: string | null;
    maxDate?: string | null;
    disabled?: boolean;
    placeholder?: string;
    openOnMount?: boolean;
    fullWidth?: boolean;
    ariaLabel?: string;
  } = $props();

  const hasTime = $derived(dateFormatHasTime(dateFormat));
  const currentDate = $derived(toDate(value));
  const displayText = $derived(formatDateValue(value, dateFormat));
  const minBoundary = $derived(toDate(minDate));
  const maxBoundary = $derived(toDate(maxDate));

  let open = $state(false);
  let viewYear = $state(new Date().getFullYear());
  let viewMonth = $state(new Date().getMonth()); // 0-11
  let timeHour = $state(0);
  let timeMinute = $state(0);
  let timeSecond = $state(0);
  let draftDate = $state<Date | null>(null);
  /** 月历内键盘焦点；选中态/今天作为初始焦点。 */
  let focusedDate = $state<Date | null>(null);
  /** popover 当前展示的层级：天 / 月 / 年。 */
  let viewMode = $state<"days" | "months" | "years">("days");
  /** 年视图分页起始（每页 12 年）。 */
  let yearPageStart = $state(Math.floor(new Date().getFullYear() / 12) * 12);

  let triggerEl = $state<HTMLButtonElement | null>(null);
  let popoverEl = $state<HTMLDivElement | null>(null);
  let popoverPos = $state<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: 280 });

  /**
   * 把 popover 节点搬到 document.body，避免被 ancestor 的 overflow:hidden 裁掉。
   *
   * 关键：作为 RevoGrid cell editor 使用时，popover portal 后不再是 grid 子节点。
   * RevoGrid 在 body 上监听 mouseup，用 composedPath().includes(grid) 判断是否点击在外，
   * 外则 clearFocus → 关闭 editor → 销毁 DatePicker。RevoGrid 注释提到："To keep your
   * elements from losing focus use mouseup/touchend e.preventDefault();"。
   *
   * 因此在 popover 的 mouseup / touchend 上 preventDefault，让 RevoGrid 跳过 clearFocus。
   * 不 stopPropagation：Svelte 5 的事件委托同时在 mount target 和 document 上注册
   * （见 svelte/src/internal/client/render.js），portal 后 popover 仍在 document 之下，
   * 事件需冒泡到 document 才能触发 onclick / oninput 等 attribute handler。
   *
   * mousedown 不 preventDefault，让 input / button 能正常聚焦。
   */
  function portal(node: HTMLElement) {
    const preventDefault = (event: Event) => {
      event.preventDefault();
    };
    document.body.appendChild(node);
    node.addEventListener("mouseup", preventDefault);
    node.addEventListener("touchend", preventDefault);
    return {
      destroy() {
        node.removeEventListener("mouseup", preventDefault);
        node.removeEventListener("touchend", preventDefault);
        if (node.parentNode === document.body) document.body.removeChild(node);
      },
    };
  }

  let mountAnchorEl = $state<HTMLSpanElement | null>(null);

  /** 基于 trigger / 父单元格的位置计算 popover 的 left/top（fixed 坐标系）。 */
  function computePopoverPosition() {
    const POPOVER_W = hasTime ? 520 : 296;
    const MARGIN = 4;
    const anchor = openOnMount ? mountAnchorEl : triggerEl;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();

    let left = rect.left;
    let top = rect.bottom + MARGIN;
    const popH = popoverEl?.offsetHeight ?? 360;

    if (left + POPOVER_W > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - POPOVER_W - 8);
    }
    if (top + popH > window.innerHeight - 8 && rect.top - popH - MARGIN > 8) {
      top = rect.top - popH - MARGIN;
    }

    popoverPos = { left, top, width: POPOVER_W };
  }

  function syncStateFrom(date: Date | null) {
    const d = date ?? new Date();
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
    timeHour = date ? d.getHours() : 0;
    timeMinute = date ? d.getMinutes() : 0;
    timeSecond = date ? d.getSeconds() : 0;
    draftDate = date
      ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())
      : null;
    focusedDate = date ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : startOfDay(new Date());
    yearPageStart = Math.floor(viewYear / 12) * 12;
    viewMode = "days";
  }

  // openOnMount 模式：挂载即打开
  $effect(() => {
    if (openOnMount && !open) {
      syncStateFrom(currentDate);
      open = true;
    }
  });

  // 打开时把视图同步到当前值
  $effect(() => {
    if (open) syncStateFrom(currentDate);
  });

  function openPopover() {
    if (disabled) return;
    open = true;
  }

  function closePopover() {
    if (!open) return;
    open = false;
    onClose?.();
  }

  function onDocumentMouseDown(event: MouseEvent) {
    if (!open) return;
    const target = event.target as Node | null;
    if (popoverEl?.contains(target)) return;
    if (triggerEl?.contains(target)) return;
    closePopover();
  }

  function onDocumentKeydown(event: KeyboardEvent) {
    if (!open) return;
    // 让 input/select 自己处理输入；只在 popover 容器或月历单元格上触发导航
    const target = event.target as HTMLElement | null;
    const inEditableField = target?.closest("input, textarea, select");

    if (event.key === "Escape") {
      event.preventDefault();
      closePopover();
      return;
    }
    if (inEditableField) return;

    if (event.key === "Enter") {
      if (viewMode === "months") {
        event.preventDefault();
        viewMode = "days";
        return;
      }
      if (viewMode === "years") {
        event.preventDefault();
        viewMode = "months";
        return;
      }
      if (focusedDate) {
        event.preventDefault();
        const cell: DayCell = {
          date: focusedDate,
          inMonth: focusedDate.getMonth() === viewMonth,
          isToday: false,
          isSelected: false,
          isFocused: false,
          disabled: outOfRange(focusedDate),
        };
        pickDay(cell);
        return;
      }
    }

    if (viewMode === "months") {
      if (event.key === "ArrowLeft") { event.preventDefault(); gotoPrevYear(); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); gotoNextYear(); return; }
      return;
    }
    if (viewMode === "years") {
      if (event.key === "ArrowLeft") { event.preventDefault(); gotoPrevYearPage(); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); gotoNextYearPage(); return; }
      return;
    }

    const step = (() => {
      switch (event.key) {
        case "ArrowLeft": return -1;
        case "ArrowRight": return 1;
        case "ArrowUp": return -7;
        case "ArrowDown": return 7;
        case "PageUp": return event.shiftKey ? -365 : -30;
        case "PageDown": return event.shiftKey ? 365 : 30;
        case "Home": return "weekStart" as const;
        case "End": return "weekEnd" as const;
        default: return null;
      }
    })();
    if (step === null) return;

    event.preventDefault();
    const base = focusedDate ?? startOfDay(new Date());
    let next: Date;
    if (step === "weekStart") {
      next = new Date(base.getFullYear(), base.getMonth(), base.getDate() - base.getDay());
    } else if (step === "weekEnd") {
      next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (6 - base.getDay()));
    } else {
      next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + step);
    }
    focusedDate = next;
    // 视图随焦点切月
    if (next.getFullYear() !== viewYear || next.getMonth() !== viewMonth) {
      viewYear = next.getFullYear();
      viewMonth = next.getMonth();
    }
  }

  $effect(() => {
    if (!open) return;
    document.addEventListener("mousedown", onDocumentMouseDown, true);
    document.addEventListener("keydown", onDocumentKeydown, true);
    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
      document.removeEventListener("keydown", onDocumentKeydown, true);
    };
  });

  /** popover 打开后立刻测量定位；窗口 resize / 任意祖先 scroll 时重测。 */
  $effect(() => {
    if (!open) return;
    queueMicrotask(() => {
      computePopoverPosition();
      popoverEl?.focus();
    });
    const raf = requestAnimationFrame(computePopoverPosition);
    const onReposition = () => computePopoverPosition();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  });

  onDestroy(() => {
    document.removeEventListener("mousedown", onDocumentMouseDown, true);
    document.removeEventListener("keydown", onDocumentKeydown, true);
  });

  // 月历网格：6 行 × 7 列，包含上下月填充
  type DayCell = {
    date: Date;
    inMonth: boolean;
    isToday: boolean;
    isSelected: boolean;
    isFocused: boolean;
    disabled: boolean;
  };

  const today = $derived(startOfDay(new Date()));

  const calendarCells = $derived<DayCell[]>(
    (() => {
      const first = new Date(viewYear, viewMonth, 1);
      const startWeekday = first.getDay(); // 0=Sun
      const gridStart = new Date(viewYear, viewMonth, 1 - startWeekday);
      const cells: DayCell[] = [];
      for (let i = 0; i < 42; i++) {
        const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
        cells.push({
          date,
          inMonth: date.getMonth() === viewMonth,
          isToday: sameDay(date, today),
          isSelected: !!draftDate && sameDay(date, draftDate),
          isFocused: !!focusedDate && sameDay(date, focusedDate),
          disabled: outOfRange(date),
        });
      }
      return cells;
    })(),
  );

  function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function sameDateTime(a: Date | null, b: Date | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.getTime() === b.getTime();
  }

  function outOfRange(d: Date): boolean {
    const day = startOfDay(d).getTime();
    if (minBoundary && day < startOfDay(minBoundary).getTime()) return true;
    if (maxBoundary && day > startOfDay(maxBoundary).getTime()) return true;
    return false;
  }

  function gotoPrevMonth() {
    if (viewMonth === 0) { viewYear -= 1; viewMonth = 11; } else { viewMonth -= 1; }
  }
  function gotoNextMonth() {
    if (viewMonth === 11) { viewYear += 1; viewMonth = 0; } else { viewMonth += 1; }
  }
  function gotoPrevYear() { viewYear -= 1; }
  function gotoNextYear() { viewYear += 1; }

  /** 标题被点击：days → months → years 逐级展开。 */
  function cycleViewMode() {
    if (viewMode === "days") viewMode = "months";
    else if (viewMode === "months") {
      yearPageStart = Math.floor(viewYear / 12) * 12;
      viewMode = "years";
    }
  }

  function pickMonth(month: number) {
    viewMonth = month;
    viewMode = "days";
  }

  function pickYear(year: number) {
    viewYear = year;
    viewMode = "months";
  }

  function gotoPrevYearPage() { yearPageStart -= 12; }
  function gotoNextYearPage() { yearPageStart += 12; }

  const monthNames = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

  /** 检查整月是否被边界完全禁用。 */
  function monthDisabled(year: number, month: number): boolean {
    const lastDay = new Date(year, month + 1, 0);
    const firstDay = new Date(year, month, 1);
    if (maxBoundary && firstDay > maxBoundary) return true;
    if (minBoundary && lastDay < startOfDay(minBoundary)) return true;
    return false;
  }

  function yearDisabled(year: number): boolean {
    if (maxBoundary && new Date(year, 0, 1) > maxBoundary) return true;
    if (minBoundary && new Date(year, 11, 31) < startOfDay(minBoundary)) return true;
    return false;
  }

  function pickDay(cell: DayCell) {
    if (cell.disabled) return;
    const next = new Date(
      cell.date.getFullYear(),
      cell.date.getMonth(),
      cell.date.getDate(),
      hasTime ? timeHour : 0,
      hasTime ? timeMinute : 0,
      hasTime ? timeSecond : 0,
    );
    draftDate = next;
    focusedDate = startOfDay(cell.date);
    viewYear = cell.date.getFullYear();
    viewMonth = cell.date.getMonth();
    if (hasTime) return;
    onChange(next);
    if (!hasTime) closePopover();
  }

  function updateDraftTime() {
    const base = draftDate ?? currentDate ?? new Date();
    const next = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      timeHour, timeMinute, timeSecond,
    );
    if (outOfRange(next)) return;
    draftDate = next;
  }

  function setTimePart(part: "h" | "m" | "s", value: number) {
    if (part === "h") timeHour = ((value % 24) + 24) % 24;
    else if (part === "m") timeMinute = ((value % 60) + 60) % 60;
    else timeSecond = ((value % 60) + 60) % 60;
    updateDraftTime();
  }

  function setToday() {
    const now = new Date();
    const next = hasTime
      ? now
      : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (outOfRange(next)) return;
    draftDate = next;
    timeHour = next.getHours();
    timeMinute = next.getMinutes();
    timeSecond = next.getSeconds();
    focusedDate = startOfDay(next);
    viewYear = next.getFullYear();
    viewMonth = next.getMonth();
    if (hasTime) return;
    onChange(next);
    if (!hasTime) closePopover();
  }

  function clearValue() {
    onChange(null);
    closePopover();
  }

  function confirmAndClose() {
    if (!sameDateTime(draftDate, currentDate)) onChange(draftDate);
    closePopover();
  }

  const monthLabel = $derived(`${viewYear} 年 ${String(viewMonth + 1).padStart(2, "0")} 月`);
  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];
  const timePreview = $derived(
    `${String(timeHour).padStart(2, "0")}:${String(timeMinute).padStart(2, "0")}:${String(timeSecond).padStart(2, "0")}`,
  );

  const headerLabel = $derived.by(() => {
    if (viewMode === "days") return monthLabel;
    if (viewMode === "months") return `${viewYear} 年`;
    return `${yearPageStart} - ${yearPageStart + 11}`;
  });
</script>

{#if !openOnMount}
  <button
    type="button"
    class="dp-trigger"
    class:full-width={fullWidth}
    class:has-value={!!displayText}
    bind:this={triggerEl}
    disabled={disabled}
    aria-label={ariaLabel ?? placeholder}
    onclick={openPopover}
  >
    <Icon name="calendar" size={14} />
    <span class="dp-trigger-text">{displayText || placeholder}</span>
  </button>
{:else}
  <span class="dp-mount-anchor" bind:this={mountAnchorEl} aria-hidden="true"></span>
{/if}

{#if open}
  <div
    class="dp-popover"
    bind:this={popoverEl}
    role="dialog"
    tabindex="-1"
    aria-label="日期选择"
    style:left="{popoverPos.left}px"
    style:top="{popoverPos.top}px"
    style:width="{popoverPos.width}px"
    use:portal
  >
    <div class="dp-body">
      <div class="dp-cal">
        <div class="dp-head">
          {#if viewMode === "days"}
            <button type="button" class="dp-nav" onclick={gotoPrevYear} aria-label="上一年">«</button>
            <button type="button" class="dp-nav" onclick={gotoPrevMonth} aria-label="上个月">
              <Icon name="chevronLeft" size={14} />
            </button>
          {:else if viewMode === "months"}
            <button type="button" class="dp-nav" onclick={gotoPrevYear} aria-label="上一年">
              <Icon name="chevronLeft" size={14} />
            </button>
          {:else}
            <button type="button" class="dp-nav" onclick={gotoPrevYearPage} aria-label="上一组">
              <Icon name="chevronLeft" size={14} />
            </button>
          {/if}

          <button
            type="button"
            class="dp-title"
            onclick={cycleViewMode}
            disabled={viewMode === "years"}
            aria-label="切换视图"
          >{headerLabel}</button>

          {#if viewMode === "days"}
            <button type="button" class="dp-nav" onclick={gotoNextMonth} aria-label="下个月">
              <Icon name="chevronRight" size={14} />
            </button>
            <button type="button" class="dp-nav" onclick={gotoNextYear} aria-label="下一年">»</button>
          {:else if viewMode === "months"}
            <button type="button" class="dp-nav" onclick={gotoNextYear} aria-label="下一年">
              <Icon name="chevronRight" size={14} />
            </button>
          {:else}
            <button type="button" class="dp-nav" onclick={gotoNextYearPage} aria-label="下一组">
              <Icon name="chevronRight" size={14} />
            </button>
          {/if}
        </div>

        {#if viewMode === "days"}
          <div class="dp-weekdays">
            {#each weekdayLabels as w}<span>{w}</span>{/each}
          </div>
          <div class="dp-grid">
            {#each calendarCells as cell}
              <button
                type="button"
                class="dp-day"
                class:dp-day-out={!cell.inMonth}
                class:dp-day-today={cell.isToday}
                class:dp-day-selected={cell.isSelected}
                class:dp-day-focused={cell.isFocused}
                disabled={cell.disabled}
                onclick={() => pickDay(cell)}
              >
                {cell.date.getDate()}
              </button>
            {/each}
          </div>
        {:else if viewMode === "months"}
          <div class="dp-month-grid">
            {#each monthNames as label, idx}
              <button
                type="button"
                class="dp-month-cell"
                class:dp-month-selected={draftDate && draftDate.getFullYear() === viewYear && draftDate.getMonth() === idx}
                disabled={monthDisabled(viewYear, idx)}
                onclick={() => pickMonth(idx)}
              >{label}</button>
            {/each}
          </div>
        {:else}
          <div class="dp-month-grid">
            {#each Array.from({ length: 12 }, (_, i) => yearPageStart + i) as year}
              <button
                type="button"
                class="dp-month-cell"
                class:dp-month-selected={draftDate && draftDate.getFullYear() === year}
                disabled={yearDisabled(year)}
                onclick={() => pickYear(year)}
              >{year}</button>
            {/each}
          </div>
        {/if}
      </div>

      {#if hasTime && viewMode === "days"}
        <div class="dp-time-panel" role="group" aria-label="时间选择">
          <div class="dp-time-header">
            <div class="dp-time-heading">
              <span class="dp-time-heading-icon">
                <Icon name="clock" size={12} />
              </span>
              <div class="dp-time-heading-copy">
                <span class="dp-time-heading-title">时间</span>
                <span class="dp-time-heading-subtitle">滚轮、键盘或点击微调</span>
              </div>
            </div>
            <span class="dp-time-badge">{timePreview}</span>
          </div>
          <div class="dp-time-cols">
            {@render timeColumn({ value: timeHour, max: 23, label: "时", onChange: (v) => setTimePart("h", v) })}
            {@render timeColumn({ value: timeMinute, max: 59, label: "分", onChange: (v) => setTimePart("m", v) })}
            {@render timeColumn({ value: timeSecond, max: 59, label: "秒", onChange: (v) => setTimePart("s", v) })}
          </div>
        </div>
      {/if}
    </div>

    <div class="dp-foot">
      <button type="button" class="dp-link" onclick={setToday}>{hasTime ? "此刻" : "今天"}</button>
      <button type="button" class="dp-link" onclick={clearValue}>清空</button>
      <span class="dp-spacer"></span>
      <button type="button" class="dp-confirm" onclick={confirmAndClose}>确定</button>
    </div>
  </div>
{/if}

{#snippet timeColumn({ value, max, label, onChange }: { value: number; max: number; label: string; onChange: (v: number) => void })}
  <div class="dp-tc">
    <div class="dp-tc-label">{label}</div>
    <div class="dp-tc-stepper">
      <button
        type="button"
        class="dp-tc-step"
        aria-label="增加{label}"
        onclick={() => onChange(value + 1)}
      >
        <Icon name="chevronUp" size={12} />
      </button>
      <input
        class="dp-tc-input"
        type="text"
        inputmode="numeric"
        value={String(value).padStart(2, "0")}
        onwheel={(e) => {
          e.preventDefault();
          onChange(value + (e.deltaY < 0 ? 1 : -1));
        }}
        onfocus={(e) => e.currentTarget.select()}
        ondblclick={() => confirmAndClose()}
        onkeydown={(e) => {
          if (e.key === "ArrowUp") { e.preventDefault(); onChange(value + 1); }
          else if (e.key === "ArrowDown") { e.preventDefault(); onChange(value - 1); }
          else if (e.key === "Enter") { e.preventDefault(); confirmAndClose(); }
        }}
        oninput={(e) => {
          const raw = e.currentTarget.value.replace(/\D/g, "").slice(-2);
          const n = raw === "" ? 0 : Number(raw);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(0, n)));
        }}
        aria-label={label}
      />
      <button
        type="button"
        class="dp-tc-step"
        aria-label="减少{label}"
        onclick={() => onChange(value - 1)}
      >
        <Icon name="chevronDown" size={12} />
      </button>
    </div>
  </div>
{/snippet}

<style>
  .dp-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 13px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: linear-gradient(180deg, #fcfdff 0%, #f6f8fc 100%);
    color: var(--text-3);
    font-size: 13px;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
    transition: border-color .14s ease, background .14s ease, color .14s ease, box-shadow .14s ease, transform .14s ease;
  }

  .dp-trigger.full-width {
    width: 100%;
    justify-content: flex-start;
  }

  .dp-trigger.has-value {
    color: var(--text-1);
  }

  .dp-trigger:hover:not(:disabled) {
    border-color: #bfd0f7;
    background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
    box-shadow: 0 8px 18px rgba(22, 100, 255, .08);
  }

  .dp-trigger:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .dp-trigger-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .dp-popover {
    position: fixed;
    z-index: 200;
    box-sizing: border-box;
    padding: 14px;
    border: 1px solid rgba(187, 199, 220, .72);
    border-radius: 20px;
    background:
      radial-gradient(circle at top left, rgba(22, 100, 255, .09), transparent 34%),
      linear-gradient(180deg, rgba(255, 255, 255, .98) 0%, rgba(249, 251, 255, .98) 100%);
    backdrop-filter: blur(18px);
    box-shadow: 0 26px 60px rgba(15, 23, 42, .16);
  }

  .dp-mount-anchor {
    display: inline-block;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .dp-body {
    display: grid;
    grid-template-columns: minmax(252px, 1fr);
    gap: 14px;
    align-items: stretch;
  }

  .dp-body:has(.dp-time-panel) {
    grid-template-columns: minmax(252px, 1fr) 176px;
  }

  .dp-cal {
    min-width: 0;
  }

  .dp-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
  }

  .dp-title {
    flex: 1;
    min-height: 40px;
    border: 0;
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(244, 247, 255, .95) 0%, rgba(236, 242, 255, .92) 100%);
    color: var(--text-1);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.25;
    cursor: pointer;
    letter-spacing: .02em;
    transition: background .12s ease, color .12s ease, transform .12s ease;
  }

  .dp-title:hover:not(:disabled) {
    background: linear-gradient(180deg, #edf3ff 0%, #e5edff 100%);
    color: var(--primary);
  }

  .dp-title:disabled {
    cursor: default;
  }

  .dp-nav {
    display: inline-flex;
    width: 32px;
    height: 32px;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 10px;
    background: rgba(255, 255, 255, .72);
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    transition: background .12s ease, color .12s ease, border-color .12s ease, transform .12s ease;
  }

  .dp-nav:hover {
    border-color: rgba(22, 100, 255, .12);
    background: #f2f6ff;
    color: var(--primary);
    transform: translateY(-1px);
  }

  .dp-weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    margin-bottom: 8px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
    text-align: center;
  }

  .dp-weekdays span {
    height: 24px;
    line-height: 24px;
  }

  .dp-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }

  .dp-day {
    position: relative;
    height: 36px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background .12s ease, color .12s ease, transform .12s ease, box-shadow .12s ease;
  }

  .dp-day:hover:not(:disabled):not(.dp-day-selected) {
    background: #edf3ff;
    color: var(--primary);
    transform: translateY(-1px);
  }

  .dp-day:disabled {
    color: #c8cfdb;
    cursor: not-allowed;
  }

  .dp-day-out {
    color: #c8cfdb;
  }

  .dp-day-today {
    box-shadow: inset 0 0 0 1px rgba(22, 100, 255, .4);
    background: rgba(22, 100, 255, .06);
  }

  .dp-day-selected {
    background: linear-gradient(180deg, #2f7bff 0%, #1664ff 100%);
    color: #fff;
    box-shadow: 0 10px 18px rgba(22, 100, 255, .22);
  }

  .dp-day-focused:not(.dp-day-selected) {
    box-shadow: inset 0 0 0 2px rgba(22, 100, 255, .4);
    background: #f4f7ff;
  }

  .dp-day-focused.dp-day-selected {
    box-shadow: 0 0 0 3px rgba(22, 100, 255, .18), 0 10px 18px rgba(22, 100, 255, .22);
  }

  .dp-month-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .dp-month-cell {
    height: 46px;
    border: 1px solid transparent;
    border-radius: 12px;
    background: linear-gradient(180deg, #f8faff 0%, #f2f5fb 100%);
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background .12s ease, color .12s ease, border-color .12s ease, transform .12s ease, box-shadow .12s ease;
  }

  .dp-month-cell:hover:not(:disabled):not(.dp-month-selected) {
    border-color: rgba(22, 100, 255, .14);
    background: #edf3ff;
    color: var(--primary);
    transform: translateY(-1px);
  }

  .dp-month-cell:disabled {
    color: #c8cfdb;
    cursor: not-allowed;
  }

  .dp-month-selected {
    background: linear-gradient(180deg, #2f7bff 0%, #1664ff 100%);
    color: #fff;
    box-shadow: 0 10px 18px rgba(22, 100, 255, .18);
  }

  /* 时分秒选择器 */
  .dp-time-panel {
    display: flex;
    flex-direction: column;
    width: 176px;
    min-width: 176px;
    padding: 12px;
    border: 1px solid rgba(216, 225, 240, .9);
    border-radius: 18px;
    background:
      linear-gradient(180deg, rgba(245, 248, 255, .96) 0%, rgba(238, 243, 252, .96) 100%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .85);
  }

  .dp-time-header {
    display: grid;
    gap: 10px;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(208, 217, 234, .7);
  }

  .dp-time-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .dp-time-heading-icon {
    display: inline-flex;
    width: 26px;
    height: 26px;
    align-items: center;
    justify-content: center;
    border-radius: 9px;
    background: rgba(22, 100, 255, .1);
    color: var(--primary);
  }

  .dp-time-heading-copy {
    display: grid;
    min-width: 0;
  }

  .dp-time-heading-title {
    color: var(--text-1);
    font-size: 12px;
    font-weight: 700;
  }

  .dp-time-heading-subtitle {
    color: var(--text-3);
    font-size: 10px;
    line-height: 1.4;
  }

  .dp-time-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    border-radius: 12px;
    background: linear-gradient(180deg, #ffffff 0%, #f4f7ff 100%);
    color: var(--primary);
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: .03em;
    box-shadow: inset 0 0 0 1px rgba(22, 100, 255, .08);
  }

  .dp-time-cols {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    flex: 1;
  }

  .dp-tc {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
    padding: 8px 6px 6px;
    border-radius: 14px;
    background: rgba(255, 255, 255, .55);
    box-shadow: inset 0 0 0 1px rgba(223, 230, 241, .88);
  }

  .dp-tc-label {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 600;
    margin-bottom: 8px;
  }

  .dp-tc-stepper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }

  .dp-tc-step {
    width: 100%;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 8px;
    background: rgba(255, 255, 255, .66);
    color: var(--text-3);
    cursor: pointer;
    transition: background .12s ease, color .12s ease, transform .12s ease;
  }

  .dp-tc-step:hover {
    background: #e8efff;
    color: var(--primary);
    transform: translateY(-1px);
  }

  .dp-tc-input {
    width: 100%;
    min-width: 0;
    height: 40px;
    padding: 0;
    border: 1px solid rgba(210, 220, 236, .9);
    border-radius: 12px;
    background: linear-gradient(180deg, #ffffff 0%, #f8faff 100%);
    color: var(--text-1);
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: center;
    letter-spacing: .02em;
    transition: border-color .12s ease, box-shadow .12s ease, background .12s ease, transform .12s ease;
  }

  @supports not selector(:has(*)) {
    .dp-body {
      display: flex;
    }

    .dp-cal {
      flex: 1;
    }
  }

  .dp-tc-input:focus {
    border-color: var(--primary);
    outline: none;
    background: #fff;
    box-shadow: 0 0 0 3px rgba(22, 100, 255, .12), 0 8px 18px rgba(22, 100, 255, .08);
  }

  .dp-foot {
    display: flex;
    align-items: center;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(219, 227, 238, .9);
    gap: 8px;
  }

  .dp-link {
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 8px;
    transition: background .12s ease, color .12s ease;
  }

  .dp-link:hover {
    background: #edf3ff;
    color: var(--primary);
  }

  .dp-spacer {
    flex: 1;
  }

  .dp-confirm {
    height: 34px;
    padding: 0 18px;
    border: 0;
    border-radius: 10px;
    background: linear-gradient(180deg, #2f7bff 0%, #1664ff 100%);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    box-shadow: 0 12px 22px rgba(22, 100, 255, .2);
    cursor: pointer;
    transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
  }

  .dp-confirm:hover {
    filter: brightness(.98);
    transform: translateY(-1px);
    box-shadow: 0 14px 24px rgba(22, 100, 255, .24);
  }
</style>
