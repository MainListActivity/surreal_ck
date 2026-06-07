<script lang="ts" module>
	export type SelectMenuOption = {
		value: string;
		label: string;
		icon?: string;
		disabled?: boolean;
	};
</script>

<script lang="ts">
	import Icon from "../../../../components/Icon.svelte";
	import * as Select from "./index.js";

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
		options: SelectMenuOption[];
		placeholder?: string;
		disabled?: boolean;
		compact?: boolean;
		fullWidth?: boolean;
		ariaLabel?: string;
		onChange?: (value: string) => void;
	} = $props();

	const selected = $derived(options.find((option) => option.value === value) ?? null);
	const iconSize = $derived(compact ? 13 : 14);

	function handleValueChange(next: string) {
		if (next === value) return;
		onChange(next);
	}
</script>

<Select.Root type="single" {value} onValueChange={handleValueChange} {disabled}>
	<Select.Trigger
		size={compact ? "sm" : "default"}
		class={fullWidth ? "w-full" : "w-fit"}
		aria-label={ariaLabel}
	>
		<span class="flex min-w-0 items-center gap-2" data-slot="select-value">
			{#if selected?.icon}
				<Icon name={selected.icon} size={iconSize} />
			{/if}
			<span class="truncate" class:text-muted-foreground={!selected || selected.disabled}>
				{selected?.label ?? placeholder}
			</span>
		</span>
	</Select.Trigger>
	<Select.Content>
		{#each options as option (option.value)}
			<Select.Item value={option.value} label={option.label} disabled={option.disabled}>
				{#if option.icon}
					<Icon name={option.icon} size={iconSize} />
				{/if}
				<span class="truncate">{option.label}</span>
			</Select.Item>
		{/each}
	</Select.Content>
</Select.Root>
