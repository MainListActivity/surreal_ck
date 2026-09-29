<script lang="ts" module>
	import { tv, type VariantProps } from "tailwind-variants";

	const inputGroupButtonVariants = tv({
		base: "gap-2 text-sm flex items-center shadow-none active:not-aria-[haspopup]:translate-y-px aria-expanded:bg-muted aria-expanded:text-foreground",
		variants: {
			size: {
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs [&>svg:not([class*='size-'])]:size-3",
				sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] [&>svg:not([class*='size-'])]:size-3.5",
				"icon-xs": "size-6 rounded-[min(var(--radius-md),10px)] p-0 has-[>svg]:p-0 [&>svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-7 rounded-[min(var(--radius-md),12px)] p-0 has-[>svg]:p-0 [&>svg:not([class*='size-'])]:size-3.5",
			},
		},
		defaultVariants: {
			size: "xs",
		},
	});

	export type InputGroupButtonSize = VariantProps<typeof inputGroupButtonVariants>["size"];
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";
	import { Button } from "$lib/components/ui/button/index.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		type = "button",
		variant = "ghost",
		size = "xs",
		...restProps
	}: Omit<ComponentProps<typeof Button>, "href" | "size"> & {
		size?: InputGroupButtonSize;
	} = $props();
</script>

<Button
	bind:ref
	{type}
	data-size={size}
	{variant}
	class={cn(inputGroupButtonVariants({ size }), className)}
	{...restProps}
>
	{@render children?.()}
</Button>
