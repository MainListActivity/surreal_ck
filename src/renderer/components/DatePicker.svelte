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
   * 自建日期选择器：触发按钮 + 浮层月历 + 可选时间行。
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

  let triggerEl = $state<HTMLButtonElement | null>(null);
  let popoverEl = $state<HTMLDivElement | null>(null);

  function syncStateFrom(date: Date | null) {
    const d = date ?? new Date();
    viewYear = d.getFullYear();
    viewMonth = d.getMonth();
    timeHour = date ? d.getHours() : 0;
    timeMinute = date ? d.getMinutes() : 0;
    timeSecond = date ? d.getSeconds() : 0;
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
    if (event.key === "Escape") {
      event.preventDefault();
      closePopover();
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
          isSelected: !!currentDate && sameDay(date, currentDate),
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
    onChange(next);
    if (!hasTime) closePopover();
  }

  function commitTime() {
    if (!currentDate) {
      // 用户先调时间再选日期；先以今天落地
      const today = new Date();
      const next = new Date(today.getFullYear(), today.getMonth(), today.getDate(), timeHour, timeMinute, timeSecond);
      if (!outOfRange(next)) onChange(next);
      return;
    }
    const next = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      currentDate.getDate(),
      timeHour, timeMinute, timeSecond,
    );
    onChange(next);
  }

  function clampHour(v: number) { return Math.max(0, Math.min(23, Number.isFinite(v) ? Math.floor(v) : 0)); }
  function clampMinSec(v: number) { return Math.max(0, Math.min(59, Number.isFinite(v) ? Math.floor(v) : 0)); }

  function setToday() {
    const now = new Date();
    const next = hasTime
      ? now
      : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (outOfRange(next)) return;
    onChange(next);
    if (!hasTime) closePopover();
  }

  function clearValue() {
    onChange(null);
    closePopover();
  }

  function confirmAndClose() {
    closePopover();
  }

  const monthLabel = $derived(`${viewYear} 年 ${String(viewMonth + 1).padStart(2, "0")} 月`);
  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];
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
{/if}

{#if open}
  <div
    class="dp-popover"
    class:dp-popover-inline={openOnMount}
    bind:this={popoverEl}
    role="dialog"
    tabindex="-1"
    aria-label="日期选择"
    onmousedown={(event) => event.stopPropagation()}
  >
    <div class="dp-head">
      <button type="button" class="dp-nav" onclick={gotoPrevYear} aria-label="上一年">«</button>
      <button type="button" class="dp-nav" onclick={gotoPrevMonth} aria-label="上个月">
        <Icon name="chevronLeft" size={14} />
      </button>
      <div class="dp-title">{monthLabel}</div>
      <button type="button" class="dp-nav" onclick={gotoNextMonth} aria-label="下个月">
        <Icon name="chevronRight" size={14} />
      </button>
      <button type="button" class="dp-nav" onclick={gotoNextYear} aria-label="下一年">»</button>
    </div>

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
          disabled={cell.disabled}
          onclick={() => pickDay(cell)}
        >
          {cell.date.getDate()}
        </button>
      {/each}
    </div>

    {#if hasTime}
      <div class="dp-time">
        <Icon name="clock" size={13} />
        <input
          type="number"
          min="0"
          max="23"
          value={timeHour}
          oninput={(e) => { timeHour = clampHour(Number(e.currentTarget.value)); commitTime(); }}
          aria-label="小时"
        />
        <span>:</span>
        <input
          type="number"
          min="0"
          max="59"
          value={timeMinute}
          oninput={(e) => { timeMinute = clampMinSec(Number(e.currentTarget.value)); commitTime(); }}
          aria-label="分钟"
        />
        <span>:</span>
        <input
          type="number"
          min="0"
          max="59"
          value={timeSecond}
          oninput={(e) => { timeSecond = clampMinSec(Number(e.currentTarget.value)); commitTime(); }}
          aria-label="秒"
        />
      </div>
    {/if}

    <div class="dp-foot">
      <button type="button" class="dp-link" onclick={setToday}>此刻</button>
      <button type="button" class="dp-link" onclick={clearValue}>清空</button>
      <span class="dp-spacer"></span>
      <button type="button" class="dp-confirm" onclick={confirmAndClose}>确定</button>
    </div>
  </div>
{/if}

<style>
  .dp-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fbfbfc;
    color: var(--text-3);
    font-size: 13px;
    cursor: pointer;
    transition: border-color .14s ease, background .14s ease, color .14s ease;
  }

  .dp-trigger.full-width {
    width: 100%;
    justify-content: flex-start;
  }

  .dp-trigger.has-value {
    color: var(--text-1);
  }

  .dp-trigger:hover:not(:disabled) {
    border-color: #b9c6e0;
    background: var(--surface);
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
    position: absolute;
    z-index: 200;
    margin-top: 4px;
    width: 280px;
    padding: 10px;
    border: 1px solid #dfe4ee;
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 18px 42px rgba(15, 23, 42, .16);
  }

  .dp-popover-inline {
    position: relative;
    margin: 0;
  }

  .dp-head {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 8px;
  }

  .dp-title {
    flex: 1;
    text-align: center;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
  }

  .dp-nav {
    display: inline-flex;
    width: 26px;
    height: 26px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
  }

  .dp-nav:hover {
    background: #f5f8ff;
    color: var(--primary);
  }

  .dp-weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    margin-bottom: 4px;
    color: var(--text-3);
    font-size: 11px;
    text-align: center;
  }

  .dp-weekdays span {
    height: 22px;
    line-height: 22px;
  }

  .dp-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }

  .dp-day {
    height: 30px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-1);
    font-size: 12px;
    cursor: pointer;
    transition: background .12s ease, color .12s ease;
  }

  .dp-day:hover:not(:disabled):not(.dp-day-selected) {
    background: #f0f5ff;
    color: var(--primary);
  }

  .dp-day:disabled {
    color: #c8cfdb;
    cursor: not-allowed;
  }

  .dp-day-out {
    color: #c8cfdb;
  }

  .dp-day-today {
    box-shadow: inset 0 0 0 1px var(--primary);
  }

  .dp-day-selected {
    background: var(--primary);
    color: #fff;
  }

  .dp-time {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 10px;
    padding: 8px 10px;
    border: 1px solid #edf1f6;
    border-radius: 8px;
    background: #fafbfd;
    color: var(--text-2);
    font-size: 12px;
  }

  .dp-time input {
    width: 44px;
    height: 26px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-1);
    font-size: 12px;
    text-align: center;
  }

  .dp-time input:focus {
    border-color: var(--primary);
    outline: none;
    box-shadow: 0 0 0 3px var(--primary-light);
  }

  .dp-foot {
    display: flex;
    align-items: center;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #edf1f6;
    gap: 6px;
  }

  .dp-link {
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: 6px;
  }

  .dp-link:hover {
    background: #f5f8ff;
    color: var(--primary);
  }

  .dp-spacer {
    flex: 1;
  }

  .dp-confirm {
    height: 28px;
    padding: 0 14px;
    border: 0;
    border-radius: 6px;
    background: var(--primary);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .dp-confirm:hover {
    background: #1a4ed8;
  }
</style>
