<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.LinkItemProps = $props();
</script>

<CommandPrimitive.LinkItem
	bind:ref
	data-slot="command-item"
	class={cn(
		"aria-selected:bg-muted aria-selected:text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex min-h-7 cursor-default items-center gap-1.5 rounded-[min(var(--radius-md),12px)] px-2.5 py-1 text-[0.8rem] active:not-aria-[haspopup]:translate-y-px outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
		className
	)}
	{...restProps}
/>
