<script lang="ts">
  import Icon from "./Icon.svelte";

  type SelectOption = {
    value: string;
    label: string;
    icon?: string;
    disabled?: boolean;
  };

  let {
    value,
    options,
    placeholder = "请选择",
    disabled = false,
    compact = false,
    fullWidth = true,
    ariaLabel,
    onChange = () => {},
  }: {
    value: string;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    compact?: boolean;
    fullWidth?: boolean;
    ariaLabel?: string;
    onChange?: (value: string) => void;
  } = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let menuStyle = $state("left: 0px; top: 0px; width: 0px; max-height: 240px;");
  let placement = $state<"bottom" | "top">("bottom");

  const selected = $derived(options.find((option) => option.value === value) ?? null);

  function close() {
    open = false;
  }

  function toggle() {
    if (disabled) return;
    open = !open;
  }

  function selectOption(optionValue: string) {
    if (optionValue === value) {
      close();
      return;
    }
    onChange(optionValue);
    close();
  }

  function updatePosition() {
    if (!open || !triggerEl || !menuEl) return;

    const rect = triggerEl.getBoundingClientRect();
    const menuHeight = menuEl.offsetHeight || 240;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const shouldOpenUpward = spaceBelow < Math.min(menuHeight, 220) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, shouldOpenUpward ? spaceAbove : spaceBelow);
    const top = shouldOpenUpward
      ? Math.max(12, rect.top - Math.min(menuHeight, maxHeight) - 8)
      : Math.min(viewportHeight - 12, rect.bottom + 8);

    placement = shouldOpenUpward ? "top" : "bottom";
    menuStyle = `left: ${Math.round(rect.left)}px; top: ${Math.round(top)}px; width: ${Math.round(rect.width)}px; max-height: ${Math.round(maxHeight)}px;`;
  }

  function handleDocumentPointer(event: MouseEvent) {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (triggerEl?.contains(target) || menuEl?.contains(target)) return;
    close();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") close();
  }

  $effect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
  });

  $effect(() => {
    if (!open || !menuEl) return;
    document.body.appendChild(menuEl);
    return () => {
      menuEl?.remove();
    };
  });

  $effect(() => {
    if (!open) return;
    const handleScroll = () => updatePosition();
    window.addEventListener("resize", handleScroll);
    window.addEventListener("scroll", handleScroll, true);
    document.addEventListener("mousedown", handleDocumentPointer);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("resize", handleScroll);
      window.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("mousedown", handleDocumentPointer);
      document.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<div class:full-width={fullWidth} class="select-shell">
  <button
    bind:this={triggerEl}
    type="button"
    class="select-trigger"
    class:compact
    class:open
    disabled={disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel}
    onclick={toggle}
  >
    <span class="trigger-copy" class:placeholder={!selected || selected.disabled}>
      {#if selected?.icon}
        <Icon name={selected.icon} size={compact ? 13 : 14} />
      {/if}
      <span>{selected?.label ?? placeholder}</span>
    </span>
    <span class="trigger-caret" class:open>
      <Icon name="chevronDown" size={compact ? 13 : 14} />
    </span>
  </button>
</div>

{#if open}
  <div
    bind:this={menuEl}
    class="select-menu"
    class:compact
    class:upward={placement === "top"}
    role="listbox"
    tabindex="-1"
    style={menuStyle}
  >
    {#each options as option}
      <button
        type="button"
        class="select-option"
        class:selected={option.value === value}
        disabled={option.disabled}
        role="option"
        aria-selected={option.value === value}
        onclick={() => selectOption(option.value)}
      >
        <span class="option-main">
          {#if option.icon}
            <Icon name={option.icon} size={compact ? 13 : 14} />
          {/if}
          <span>{option.label}</span>
        </span>
        {#if option.value === value}
          <Icon name="check" size={compact ? 13 : 14} />
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .select-shell {
    position: relative;
    display: inline-flex;
  }

  .select-shell.full-width {
    display: flex;
    width: 100%;
  }

  .select-trigger {
    display: inline-flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    outline: none;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, .98), rgba(247, 249, 252, .98));
    color: var(--text-1);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .7);
    transition:
      border-color .18s ease,
      box-shadow .18s ease,
      transform .18s ease,
      background .18s ease;
  }

  .select-trigger.compact {
    height: 32px;
    padding: 0 10px;
    border-radius: 10px;
    font-size: 12px;
  }

  .select-trigger:hover:not(:disabled) {
    border-color: #cfd8e6;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 1), rgba(244, 247, 251, 1));
  }

  .select-trigger:focus-visible,
  .select-trigger.open {
    border-color: #8db3ff;
    box-shadow:
      0 0 0 3px rgba(22, 100, 255, .12),
      0 10px 24px rgba(15, 23, 42, .08);
  }

  .select-trigger:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .trigger-copy {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .trigger-copy.placeholder {
    color: var(--text-3);
    font-weight: 400;
  }

  .select-trigger.compact .trigger-copy {
    font-size: 12px;
  }

  .trigger-copy :global(svg) {
    color: #6c788f;
    flex-shrink: 0;
  }

  .trigger-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
    transition: transform .18s ease, color .18s ease;
  }

  .trigger-caret.open {
    transform: rotate(180deg);
    color: var(--text-2);
  }

  .select-menu {
    position: fixed;
    z-index: 250;
    display: grid;
    gap: 4px;
    overflow: auto;
    padding: 6px;
    border: 1px solid rgba(207, 216, 230, .95);
    border-radius: 14px;
    background: rgba(255, 255, 255, .96);
    box-shadow:
      0 18px 40px rgba(15, 23, 42, .16),
      0 2px 8px rgba(15, 23, 42, .08);
    backdrop-filter: blur(14px);
  }

  .select-menu.compact {
    gap: 3px;
    padding: 5px;
    border-radius: 12px;
  }

  .select-option {
    display: inline-flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 38px;
    padding: 0 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-1);
    text-align: left;
    transition: background-color .15s ease, color .15s ease;
  }

  .select-menu.compact .select-option {
    min-height: 32px;
    padding: 0 9px;
    border-radius: 9px;
    font-size: 12px;
  }

  .select-option:hover:not(:disabled) {
    background: #f4f7fb;
  }

  .select-option.selected {
    background: #edf4ff;
    color: #1d4ed8;
    font-weight: 600;
  }

  .select-option:disabled {
    opacity: .45;
    cursor: not-allowed;
  }

  .option-main {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .option-main :global(svg),
  .select-option > :global(svg) {
    flex-shrink: 0;
  }
</style>
